#!/usr/bin/env node
// Focused Design canvas benchmark for before/after comparisons on macOS.
// Production renderer + compiled engine in an isolated account-free Local
// profile. Fixtures are disposable copies; the operator's profile is untouched.
// The window floats on the built-in display, ignores OS mouse input and never
// takes focus; all input is CDP-dispatched so the operator can keep working.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { localEnvironment, pickLocalPorts } from "./electron-local.mjs";
import { launchNativeElectron } from "./design-native-electron.mjs";
import { buildNativeProduction, productionProbeSource, serveNativeProductionAssets } from "./design-native-production.mjs";
import { nativeProductionViteConfiguration } from "./design-native-vite.mjs";

// Same isolated production build as the native workload, with a 2 GiB disk
// guard: the owner's Mac runs near full and the build itself needs < 1 GiB.
async function buildBenchProduction({ repo, root, env, run }) {
  const disk = await fs.statfs(root), free = disk.bavail * disk.bsize;
  if (free >= 4 * 1024 ** 3) return buildNativeProduction({ repo, root, env, run });
  if (free < 2 * 1024 ** 3) throw new Error("Bench build needs at least 2 GiB free.");
  const stage = path.join(root, "app"); await fs.mkdir(stage);
  for (const directory of ["node_modules", "apps", "packages", "resources", "styles"]) {
    try { await fs.access(path.join(repo, directory)); await fs.symlink(path.join(repo, directory), path.join(stage, directory), "dir"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  // build-sidecar.mjs reads the release workflow's Bun pin.
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
import { withNativeRendererModules, nativePageSession, waitForNativeRenderer } from "./design-native-renderer.mjs";
import { activateNativeWorkbenchTab, prepareNativeWorkspaceCatalog } from "./design-native-workbench.mjs";
import { prepareNativeDesignView, readNativeDesignCoverage, dispatchNativeDesignGesture,
  startNativeDesignCameraObservation, finishNativeDesignCameraObservation } from "./design-native-view.mjs";
import { sampleNativeApplicationMemory, observeNativeApplicationProcesses, nativeApplicationProcessIdentities,
  waitForNativeProcessRetirement } from "./design-native-memory.mjs";
import { analyzeDesignPresentationTrace } from "./design-performance-budget.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const exec = promisify(execFile);
const viewportSelector = '[data-design-retained-workspace][aria-hidden="false"] [data-design-canvas-viewport]';

function option(args, name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  assert(value && !value.startsWith("--"), `${name} requires a value.`);
  return value;
}

const percentile = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p / 100 * sorted.length) - 1))];
};

async function main() {
  const args = process.argv.slice(2);
  assert.equal(process.platform, "darwin", "This benchmark requires macOS.");
  const label = option(args, "--label", "run");
  assert(/^[A-Za-z0-9._-]{1,40}$/.test(label), "Invalid --label.");
  const fixtureNames = option(args, "--fixtures", "real,grid256").split(",").filter(name => name && name !== "none");
  const idleSeconds = Number(option(args, "--idle-seconds", "30"));
  const reps = Number(option(args, "--reps", "2"));
  const inspectCount = Number(option(args, "--inspect", "8"));
  const reuseBuild = option(args, "--reuse-build", null);
  const extraFixtures = option(args, "--fixture-dir", null); // existing generated checkouts: name=path;name=path
  const profile = args.includes("--profile");
  const nativeGestures = args.includes("--native-gestures");
  const detailTrace = args.includes("--detail-trace");
  // Chromium's vsync-aligned synthetic gestures (the Telemetry smoothness
  // input) are the default; 120 Hz Input.dispatchMouseEvent wheel injection
  // queues behind DevTools ACKs and caps even a trivial page near 35 fps.
  const inputMode = option(args, "--input", "synth");
  const cleanup = args.includes("--cleanup");
  const memoryDump = args.includes("--memory-dump");
  const profileOpen = args.includes("--profile-open");
  const profileCold = args.includes("--profile-cold");
  // Recorded GPU canvas (Phase 1): recorder on, internal flag on, and the
  // canvas's own timings (window.__zerosDesignGpu) decide when an open is done.
  const gpu = args.includes("--gpu");
  const skip = new Set(option(args, "--skip", "").split(",").filter(Boolean));
  const root = path.join(repo, ".context/design-canvas-bench");
  const runId = `${label}-${new Date().toISOString().replace(/[^0-9T]/g, "").slice(0, 15)}-${randomUUID().slice(0, 6)}`;
  const evidence = path.join(root, runId);
  await fs.mkdir(evidence, { recursive: true, mode: 0o700 });
  const report = { runId, label, startedAt: new Date().toISOString(), stage: "preparing", pid: process.pid,
    git: (await exec("git", ["-C", repo, "rev-parse", "HEAD"])).stdout.trim(),
    dirty: (await exec("git", ["-C", repo, "status", "--porcelain", "--", "apps", "packages", "scripts"])).stdout.trim().split("\n").filter(Boolean).length,
    hardware: { cpu: os.cpus()[0]?.model, memoryBytes: os.totalmem(), os: os.release() }, fixtures: [] };
  const save = stage => { if (stage) report.stage = stage; return fs.writeFile(path.join(evidence, "report.json"), JSON.stringify(report, null, 2)); };
  const phase = async stage => { await save(stage); console.log(`BENCH ${new Date().toISOString()} ${stage}`); };
  await fs.writeFile(path.join(root, "latest.json"), JSON.stringify({ runId }));
  await save();
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(new Error("Benchmark deadline exceeded.")), 40 * 60_000);
  process.once("SIGINT", () => controller.abort(new Error("cancelled"))); process.once("SIGTERM", () => controller.abort(new Error("cancelled")));
  const pause = ms => delay(ms, undefined, { signal: controller.signal });
  const run = async (command, argv, options = {}) => (await exec(command, argv, { cwd: repo, timeout: 600_000,
    maxBuffer: 32 * 1024 ** 2, signal: controller.signal, ...options })).stdout;
  let app, server, processes;
  try {
    // Two runs can share one isolated profile: the second launch then opens
    // with the first run's stored pictures (an app restart).
    const profileSlug = option(args, "--profile-slug", null);
    assert(!profileSlug || /^canvas-bench-[a-f0-9]{6}$/.test(profileSlug), "Invalid --profile-slug.");
    const identity = { slug: profileSlug ?? `canvas-bench-${runId.slice(-6)}`, name: "Zeros Canvas Bench" };
    const ports = await pickLocalPorts(identity.slug);
    const env = localEnvironment({ identity, ...ports });
    Object.assign(env, { NODE_ENV: "production", ZEROS_NO_MAIN_HMR: "1", ZEROS_NO_ENGINE_HMR: "1" });
    if (gpu) {
      env.ZEROS_DESIGN_RECORDER = "1";
      const windows = option(args, "--recorder-windows", null);
      if (windows) env.ZEROS_DESIGN_RECORDER_WINDOWS = windows;
      if (args.includes("--recorder-timings")) env.ZEROS_DESIGN_RECORDER_TIMINGS = path.join(evidence, "recorder-timings.jsonl");
    }
    report.gpu = gpu;
    // localEnvironment() drops every inherited ZEROS_* variable, so engine
    // tuning set on the bench's command line must be passed on explicitly.
    report.passedEnv = {};
    for (const key of ["ZEROS_DESIGN_PREPARATION_WORKERS", "ZEROS_DESIGN_RECORDINGS_TIMINGS", "ZEROS_DESIGN_RECORDER_WINDOWS",
      "ZEROS_DESIGN_RECORDER_FRAMES_PER_WINDOW"]) if (process.env[key]) { env[key] = process.env[key]; report.passedEnv[key] = process.env[key]; }
    // Production macOS engines watch through the native watch host; without it
    // the compiled engine falls back to stat polling and idle CPU measures that.
    const watchHostScript = path.join(repo, "apps/desktop/src/engine/git/watch-host.cjs");
    if (!args.includes("--no-watch-host")) try { await fs.access(watchHostScript); env.ZEROS_WATCH_HOST_SCRIPT = watchHostScript; } catch {}
    report.watchHost = Boolean(env.ZEROS_WATCH_HOST_SCRIPT);
    const captureDump = Number(option(args, "--capture-dump", "0"));
    if (captureDump > 0) env.ZEROS_BENCH_CAPTURE_DUMP = path.join(os.homedir(), ".zeros-dev/canvas-perf/capture-dump", runId);
    await phase("build");
    let built;
    if (reuseBuild) {
      built = JSON.parse(await fs.readFile(path.join(reuseBuild, "build.json"), "utf8"));
    } else {
      const started = performance.now();
      built = await buildBenchProduction({ repo, root: evidence, env, run });
      report.buildMs = performance.now() - started;
      await fs.writeFile(path.join(evidence, "build.json"), JSON.stringify(built));
    }
    server = await serveNativeProductionAssets(built.output, ports.vitePort);
    env.ELECTRON_RENDERER_URL = server.url;

    await phase("fixtures");
    const fixtures = [];
    const fixtureRoot = path.join(evidence, "fixtures");
    await fs.mkdir(fixtureRoot);
    const commit = async folder => {
      await run("git", ["-C", folder, "add", "-A"]);
      await run("git", ["-C", folder, "-c", "user.name=bench", "-c", "user.email=bench@example.invalid", "commit", "-qm", "fixture"]);
      return (await run("git", ["-C", folder, "symbolic-ref", "--short", "HEAD"])).trim();
    };
    for (const name of fixtureNames) {
      const folder = path.join(fixtureRoot, name);
      if (name === "real") {
        await fs.mkdir(folder);
        await run("git", ["init", "-q", folder]);
        await fs.cp(path.join(repo, "Zeros - Design"), path.join(folder, "Zeros - Design"), { recursive: true });
        const canvas = JSON.parse(await fs.readFile(path.join(folder, "Zeros - Design/meta/canvas.json"), "utf8"));
        const page = [...canvas.pages].sort((a, b) => b.frames.length - a.frames.length)[0];
        fixtures.push({ name, path: folder, repoRoot: folder, repoSlug: `bench-${name}`, branchName: await commit(folder),
          pageId: page.id, count: page.frames.length });
      } else {
        const match = /^(grid|complex)(\d+)$/.exec(name);
        assert(match, `Unknown fixture ${name}.`);
        const generatorArgs = ["scripts/design-performance-fixture.ts", "--frames", match[2], "--layout", "grid", "--output", folder,
          ...(match[1] === "complex" ? ["--complex"] : [])];
        const output = await run("bun", generatorArgs);
        JSON.parse(output.slice(output.indexOf("{")));
        fixtures.push({ name, path: folder, repoRoot: folder, repoSlug: `bench-${name}`, branchName: await commit(folder),
          pageId: null, count: Number(match[2]) });
      }
    }
    if (extraFixtures) for (const entry of extraFixtures.split(";")) {
      let [name, folder, pageId, count] = entry.split("=");
      if (!pageId) {
        const design = (await fs.readdir(folder, { withFileTypes: true })).find(d => d.isDirectory() &&
          (fs.access(path.join(folder, d.name, "meta/canvas.json")).then(() => true, () => false)));
        const dirs = (await fs.readdir(folder, { withFileTypes: true })).filter(d => d.isDirectory());
        for (const d of dirs) {
          try {
            const canvas = JSON.parse(await fs.readFile(path.join(folder, d.name, "meta/canvas.json"), "utf8"));
            const page = canvas.pages[0]; pageId = page.id; count = String(page.frames.length); break;
          } catch {}
        }
        void design;
      }
      fixtures.push({ name, path: folder, repoRoot: folder, repoSlug: `bench-${name}`, branchName: await commit(folder).catch(async () =>
        (await run("git", ["-C", folder, "symbolic-ref", "--short", "HEAD"])).trim()), pageId: pageId || null, count: Number(count) });
    }

    await phase("launch");
    // The owner keeps working on this Mac: Spaces and other apps occlude the
    // bench window, which Chromium would treat as hidden (no frames, paused
    // background work). Keep rendering while occluded; recorded in the report.
    const switches = args.includes("--native-occlusion") ? [] :
      ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding"];
    report.chromiumSwitches = switches;
    app = await launchNativeElectron({ args: [...switches, built.stage], cwd: fixtures[0].path, env, timeout: 90_000 });
    const mainPid = app.process().pid;
    // Main-process lines name engine restarts and their reasons. Only [Zeros]
    // lifecycle lines are kept; they carry ports and PIDs, never tokens.
    report.mainLog = [];
    for (const stream of [app.process().stdout, app.process().stderr]) stream?.on("data", chunk => {
      for (const line of String(chunk).split("\n")) {
        const fatal = /FATAL|Fatal error|heap out of memory|Check failed|allocation failed|Abort|SIGTRAP|SIGABRT|panic|crash|bun\.report|Segmentation|oh no|bun v\d/i.test(line);
        if (!fatal && (!/\[Zeros\]/.test(line) || !/engine|watchdog|respawn|crash|exit|stall|unreachable|maintenance/i.test(line))) continue;
        if (report.mainLog.length >= 300) continue;
        report.mainLog.push(`${new Date().toISOString().slice(11, 23)} ${line.replace(/token=[^\s&]+/g, "token=<redacted>").slice(0, 300)}`);
      }
    });
    await observeNativeApplicationProcesses(app);
    const rawPage = await app.firstWindow({ timeout: 60_000 }); rawPage.setDefaultTimeout(30_000);
    const ablate = option(args, "--ablate", "").split(",").filter(Boolean);
    await rawPage.addInitScript(({ ablate, gpu }) => {
      localStorage.setItem("zeros.column2.ratio", "0.1"); if (ablate.length) globalThis.__ZEROS_DESIGN_ABLATE = ablate;
      if (gpu) {
        let flags = {};
        try { flags = JSON.parse(localStorage.getItem("zeros.internalFeatures") || "{}") ?? {}; } catch {}
        localStorage.setItem("zeros.internalFeatures", JSON.stringify({ ...flags, designGpuCanvas: true }));
      }
      // Bridge request mix (counts and bytes by message type/op) for engine attribution.
      const ops = globalThis.__benchOps = { counts: {}, bytes: {} };
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        try {
          if (typeof data === "string") {
            const message = JSON.parse(data);
            const key = [message.type, message.op ?? message.operation ?? message.payload?.op ?? message.method].filter(Boolean).join(":") || "unknown";
            ops.counts[key] = (ops.counts[key] ?? 0) + 1; ops.bytes[key] = (ops.bytes[key] ?? 0) + data.length;
            // Who sends Design selection writes (stacks map back through the build's source maps).
            if (key.endsWith("design.selection.set")) {
              Error.stackTraceLimit = 80;
              const stacks = globalThis.__benchSelectionStacks ??= [];
              if (stacks.length < 12) stacks.push(String(new Error().stack).split("\n").slice(2, 70).join("\n"));
            }
          }
        } catch {}
        return send.call(this, data);
      };
    }, { ablate, gpu });
    report.ablate = ablate;
    await rawPage.reload({ waitUntil: "domcontentloaded" });
    report.console = [];
    rawPage.on("console", message => {
      if (!["error", "warning"].includes(message.type()) || report.console.length >= 200) return;
      report.console.push(`${message.type()}: ${message.text().slice(0, 300)}`);
    });
    const page = await withNativeRendererModules(rawPage, { moduleUrl: `${server.url}/${built.modulePath}` });
    await waitForNativeRenderer(page, async () =>
      (await import("/apps/desktop/src/renderer/platform/bridge/active-bridge.ts")).getActiveBridge()?.status === "connected", undefined, 60_000);
    const rows = (await run("ps", ["-axo", "pid=,ppid=,comm="])).split("\n").map(row => row.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean);
    const engines = rows.filter(row => Number(row[2]) === mainPid && row[3].startsWith(path.join(built.stage, "binaries/zeros-engine-")));
    assert.equal(engines.length, 1, "The benchmark must measure its compiled engine.");
    const enginePid = Number(engines[0][1]);
    report.runtime = await app.evaluate(({ BrowserWindow, screen }) => {
      const window = BrowserWindow.getAllWindows()[0];
      const display = screen.getAllDisplays().find(d => d.internal) ?? screen.getPrimaryDisplay();
      const area = display.workArea;
      window.setBounds({ x: area.x, y: area.y, width: Math.min(1440, area.width), height: Math.min(900, area.height) });
      // Visible, never focused, following the operator's Space. Skip the
      // process-type transform: as an accessory app Chromium saw it occluded.
      window.setVisibleOnAllWorkspaces(true, { skipTransformProcessType: true });
      window.setAlwaysOnTop(true, "floating");
      window.setIgnoreMouseEvents(true);
      window.showInactive();
      return { mainPid: process.pid, electron: process.versions.electron, chromium: process.versions.chrome,
        display: { internal: display.internal, frequencyHz: display.displayFrequency, scaleFactor: display.scaleFactor, size: display.size },
        bounds: window.getBounds() };
    });
    report.runtime.enginePid = enginePid;
    await save();
    const cdp = await nativePageSession(rawPage);
    await cdp.send("Performance.enable");
    const sample = () => sampleNativeApplicationMemory({ app, enginePid });
    const metrics = () => app.evaluate(({ app }) => app.getAppMetrics().map(m => ({ pid: m.pid, type: m.type,
      cpuSeconds: m.cpu.cumulativeCPUUsage, wakeups: m.cpu.idleWakeupsPerSecond })));
    const summarize = rows => {
      const byRole = {};
      for (const row of rows) {
        const role = row.role === "Tab" ? "renderer" : row.role === "Browser" ? "main" : row.role === "GPU" ? "gpu"
          : row.role === "local-engine" ? "engine" : row.role === "Utility" ? "utility" : "other";
        byRole[role] = (byRole[role] ?? 0) + (row.physicalFootprintBytes ?? 0);
      }
      byRole.total = rows.reduce((n, row) => n + (row.physicalFootprintBytes ?? 0), 0);
      return byRole;
    };
    const renderer = async () => {
      const [heap, dom, perf, resources] = await Promise.all([cdp.send("Runtime.getHeapUsage"), cdp.send("Memory.getDOMCounters"),
        cdp.send("Performance.getMetrics"),
        page.evaluate(async () => (await import("/apps/desktop/src/renderer/features/design-workspace/state/design-renderer-resources.ts")).designRendererResources())]);
      const pm = Object.fromEntries(perf.metrics.map(m => [m.name, m.value]));
      const counts = await page.evaluate(() => ({ iframes: document.querySelectorAll("iframe").length,
        images: document.querySelectorAll("img").length, canvases: document.querySelectorAll("canvas").length,
        elements: document.getElementsByTagName("*").length }));
      return { heapUsed: heap.usedSize, heapTotal: heap.totalSize, dom, counts,
        layoutCount: pm.LayoutCount, recalcStyleCount: pm.RecalcStyleCount, layoutDuration: pm.LayoutDuration,
        recalcStyleDuration: pm.RecalcStyleDuration, scriptDuration: pm.ScriptDuration, taskDuration: pm.TaskDuration, resources };
    };
    // The operator keeps working: Spaces, display changes and full-screen apps
    // can hide the window. Re-assert it and wait (bounded) for visibility.
    const ensureVisible = async (fixture) => {
      for (let attempt = 0; attempt < 1200; attempt++) {
        await app.evaluate(({ app, BrowserWindow, screen }) => {
          // "Hide Others" in the operator's app hides this whole application;
          // app.show() unhides it without focusing.
          if (process.platform === "darwin" && app.isHidden?.()) app.show();
          const window = BrowserWindow.getAllWindows()[0];
          const display = screen.getAllDisplays().find(d => d.internal) ?? screen.getPrimaryDisplay();
          const area = display.workArea, bounds = window.getBounds();
          if (bounds.x < area.x || bounds.y < area.y || bounds.x + bounds.width > area.x + area.width || bounds.y + bounds.height > area.y + area.height)
            window.setBounds({ x: area.x, y: area.y, width: Math.min(1440, area.width), height: Math.min(900, area.height) });
          // Never re-call setVisibleOnAllWorkspaces here: each call transforms
          // the process type, which hides the window and Dock for a moment.
          if (!window.isAlwaysOnTop()) window.setAlwaysOnTop(true, "floating");
          if (!window.isVisible()) window.showInactive();
        });
        const state = await page.evaluate(() => document.visibilityState);
        const owner = await page.evaluate(() => Boolean(document.querySelector('[data-design-retained-workspace][aria-hidden="false"] [data-design-canvas-viewport]')));
        if (state === "visible" && owner) { if (attempt) report.visibilityWaits = (report.visibilityWaits ?? 0) + attempt; return; }
        if (state === "visible" && !owner && fixture) await activateNativeWorkbenchTab(page, fixture.path, "design").catch(() => {});
        await pause(500);
      }
      throw new Error("Bench window stayed hidden for 10 min.");
    };
    const gpuSnapshot = () => page.evaluate(async () => { const g = globalThis.__zerosDesignGpu; if (!g) return null;
      try { return await g.snapshot(); } catch (error) { return { error: String(error) }; } }).catch(() => null);
    const gpuReset = () => page.evaluate(() => globalThis.__zerosDesignGpu?.reset?.()).catch(() => {});
    const gpuState = () => page.evaluate(() => ({ plane: Boolean(document.querySelector("[data-design-gpu-plane]")),
      tiled: document.querySelectorAll("[data-design-frame-tiled]").length, version: globalThis.__zerosDesignGpu?.version ?? null })).catch(() => null);
    const takeOps = () => page.evaluate(() => { const ops = globalThis.__benchOps; if (!ops) return null;
      const out = { counts: ops.counts, bytes: ops.bytes }; globalThis.__benchOps = { counts: {}, bytes: {} }; return out; });
    // Chromium memory-infra: allocator totals per process (effective sizes).
    const dumpMemory = async label => {
      const events = []; const collect = d => events.push(...d.value);
      cdp.on("Tracing.dataCollected", collect);
      const complete = new Promise(resolve => cdp.once("Tracing.tracingComplete", resolve));
      await cdp.send("Tracing.start", { traceConfig: { includedCategories: ["disabled-by-default-memory-infra"], memoryDumpConfig: { triggers: [] } }, transferMode: "ReportEvents" });
      const dumped = await cdp.send("Tracing.requestMemoryDump", { deterministic: true, levelOfDetail: "detailed" }).catch(e => ({ error: String(e) }));
      await cdp.send("Tracing.end"); await complete; cdp.off("Tracing.dataCollected", collect);
      const names = new Map(); for (const e of events) if (e.ph === "M" && e.name === "process_name") names.set(e.pid, e.args.name);
      const out = {};
      for (const e of events) if (e.ph === "v" && e.args?.dumps?.allocators) {
        const proc = `${names.get(e.pid) ?? "pid"}:${e.pid}`; const row = out[proc] ??= {};
        for (const [name, a] of Object.entries(e.args.dumps.allocators)) {
          const depth = name.split("/").length;
          const size = parseInt(a.attrs?.effective_size?.value ?? a.attrs?.size?.value ?? "0", 16);
          if (depth <= 2 && size) row[name] = size;
        }
      }
      return { label, dumped, processes: out };
    };
    // CPU over a window: Electron cumulative CPU per process + engine via ps sample.
    const cpuWindow = async (name, seconds, during) => {
      const before = await sample(), m0 = await metrics(), r0 = await cdp.send("Performance.getMetrics"), t0 = performance.now();
      if (during) await during(); else await pause(seconds * 1000);
      const after = await sample(), m1 = await metrics(), r1 = await cdp.send("Performance.getMetrics"), wall = (performance.now() - t0) / 1000;
      const cpu = {};
      for (const row of after) {
        const old = before.find(p => p.pid === row.pid);
        if (!old || !Number.isFinite(old.cpuSeconds) || !Number.isFinite(row.cpuSeconds)) continue;
        const role = row.role === "Tab" ? "renderer" : row.role === "Browser" ? "main" : row.role === "GPU" ? "gpu"
          : row.role === "local-engine" ? "engine" : row.role === "Utility" ? "utility" : "other";
        cpu[role] = (cpu[role] ?? 0) + (row.cpuSeconds - old.cpuSeconds) / wall * 100;
      }
      cpu.total = Object.values(cpu).reduce((a, b) => a + b, 0);
      const perProcess = after.map(row => { const old = before.find(p => p.pid === row.pid);
        return old && Number.isFinite(old.cpuSeconds) && Number.isFinite(row.cpuSeconds)
          ? { pid: row.pid, role: row.role, percent: (row.cpuSeconds - old.cpuSeconds) / wall * 100, memoryMB: (row.physicalFootprintBytes ?? 0) / 2 ** 20 } : null; })
        .filter(Boolean).filter(row => row.percent >= 0.5 || row.memoryMB >= 50);
      const processCount = { before: before.length, after: after.length, tabs: after.filter(row => row.role === "Tab").length };
      const pm0 = Object.fromEntries(r0.metrics.map(m => [m.name, m.value])), pm1 = Object.fromEntries(r1.metrics.map(m => [m.name, m.value]));
      const wake = m1.filter(m => m.type === "Tab" || m.type === "GPU").map(m => ({ type: m.type, wakeups: m.wakeups }));
      return { name, wallSeconds: wall, cpuPercent: cpu, perProcess, processCount, memoryAfter: summarize(after), memoryBefore: summarize(before), wakeups: wake,
        rendererMain: { taskSeconds: pm1.TaskDuration - pm0.TaskDuration, scriptSeconds: pm1.ScriptDuration - pm0.ScriptDuration,
          layoutSeconds: pm1.LayoutDuration - pm0.LayoutDuration, styleSeconds: pm1.RecalcStyleDuration - pm0.RecalcStyleDuration,
          layouts: pm1.LayoutCount - pm0.LayoutCount, styles: pm1.RecalcStyleCount - pm0.RecalcStyleCount } };
    };

    const adopt = fixture => page.evaluate(async fixture => {
        const { upsertProject } = await import("/apps/desktop/src/renderer/state/projects-store.ts");
        const { notifyProjectsChanged, notifyWorkspacesChanged } = await import("/apps/desktop/src/renderer/state/use-projects.ts");
        const { workspaceAdoptExisting } = await import("/apps/desktop/src/renderer/platform/git.ts");
        const project = upsertProject({ repoRoot: fixture.path, repoSlug: fixture.repoSlug, isGitRepository: true });
        notifyProjectsChanged();
        const id = (await workspaceAdoptExisting({ repoRoot: fixture.path, worktreePath: fixture.path,
          branchName: fixture.branchName, repoSlug: project.repoSlug, organizationId: null })).workspaceId;
        notifyWorkspacesChanged(project.repoSlug); return id;
      }, fixture);
    for (const fixture of fixtures) fixture.id = await adopt(fixture);
    await prepareNativeWorkspaceCatalog(page, fixtures.map(f => ({ folder: f.path, workspaceId: f.id })));
    // Large pages may never cover every frame (admission budgets); record the
    // coverage timeline and settle when it stops growing for 6 s.
    const coverageTimeoutMs = Number(option(args, "--coverage-timeout", "300")) * 1000;
    const settleMs = Number(option(args, "--settle", "20")) * 1000;
    const progress = () => page.evaluate(async () => {
      const r = (await import("/apps/desktop/src/renderer/features/design-workspace/state/design-renderer-resources.ts")).designRendererResources();
      return { prepared: r.preparation?.prepared, demanded: r.preparation?.demanded, pictures: r.previews?.pictures,
        producing: r.previews?.producing, decoded: r.images?.decodedBytes, vector: r.sourcePreviews?.vector,
        native: r.sourcePreviews?.native, fallbacks: r.sourcePreviews?.fallbacks, ms: r.sourcePreviews?.ms,
        sources: r.sourceSurfaces?.frames, live: r.documents?.active };
    }).catch(() => null);
    const ready = async (fixture, timeoutMs = fixture.count >= 500 ? coverageTimeoutMs : 120_000, openBegin = Date.now()) => {
      const begin = Date.now(), until = begin + timeoutMs, timeline = [], progressLog = [], gpuLog = [];
      let lastGpuLog = 0;
      let last = -1, lastChange = begin, lastProgress = 0, reactivated = 0, hiddenSince = 0;
      // Main-thread hitches while pictures fill: what a user panning mid-load would feel.
      await page.evaluate(() => { globalThis.__benchLoaf?.disconnect?.();
        const stats = globalThis.__benchLoafStats = { count: 0, maxMs: 0, over100: 0, blockingMs: 0, renderMs: 0, styleLayoutMs: 0, scripts: {} };
        const observer = new PerformanceObserver(list => { for (const entry of list.getEntries()) { stats.count++;
          stats.maxMs = Math.max(stats.maxMs, entry.duration); if (entry.duration > 100) stats.over100++; stats.blockingMs += entry.blockingDuration ?? 0;
          // Rendering (style, layout, paint) after the scripts, and each script's own share.
          if (entry.renderStart) stats.renderMs += entry.startTime + entry.duration - entry.renderStart;
          if (entry.styleAndLayoutStart) stats.styleLayoutMs += entry.startTime + entry.duration - entry.styleAndLayoutStart;
          for (const script of entry.scripts ?? []) {
            const where = `${script.invokerType}:${script.invoker}|${script.sourceFunctionName || "?"}@${String(script.sourceURL).split("/").pop()?.split("?")[0]}:${script.sourceCharPosition}`.slice(0, 160);
            const row = stats.scripts[where] ??= [0, 0, 0]; row[0]++; row[1] += script.duration; row[2] += script.forcedStyleAndLayoutDuration ?? 0;
          } } });
        observer.observe({ type: "long-animation-frame" }); globalThis.__benchLoaf = observer; }).catch(() => {});
      const jank = () => page.evaluate(() => { const stats = globalThis.__benchLoafStats; globalThis.__benchLoaf?.disconnect?.();
        if (!stats) return null;
        const scripts = Object.entries(stats.scripts).sort((a, b) => b[1][1] - a[1][1]).slice(0, 15)
          .map(([where, [n, ms, forced]]) => `${Math.round(ms)}ms n${n} forced${Math.round(forced)} ${where}`);
        return { ...stats, maxMs: Math.round(stats.maxMs), blockingMs: Math.round(stats.blockingMs), renderMs: Math.round(stats.renderMs),
          styleLayoutMs: Math.round(stats.styleLayoutMs), scripts }; }).catch(() => null);
      for (;;) {
        const c = await readNativeDesignCoverage(page);
        // A restored session can switch the workbench away from the fixture's
        // Design tab after activation; put it back (bounded) and record it.
        if (c.id !== fixture.id && reactivated < 5) {
          hiddenSince ||= Date.now();
          if (Date.now() - hiddenSince > 2000) {
            reactivated++; hiddenSince = 0;
            await page.evaluate(async fixture => {
              const { useWorkspaceStore } = await import("/apps/desktop/src/renderer/state/workspace-store.ts");
              useWorkspaceStore.getState().dispatch({ type: "OPEN_WORKSPACE", folder: fixture.path, repoRoot: fixture.repoRoot, chatId: null });
            }, fixture).catch(() => {});
            await activateNativeWorkbenchTab(page, fixture.path, "design").catch(() => {});
            timeline.push([Date.now() - begin, -1, -1, "reactivated"]);
          }
        } else hiddenSince = 0;
        if (c.id === fixture.id && c.covered !== last) { last = c.covered; lastChange = Date.now();
          timeline.push([Date.now() - begin, c.covered, c.frames, await page.evaluate(() => document.visibilityState[0])]); }
        if (fixture.count >= 500 && Date.now() - lastProgress >= 5000) { lastProgress = Date.now();
          progressLog.push([Date.now() - begin, c.covered, c.frames, await progress()]); }
        if (gpu && c.id === fixture.id) {
          const g = await gpuSnapshot();
          if (Date.now() - lastGpuLog >= 1000) { lastGpuLog = Date.now();
            gpuLog.push([Date.now() - openBegin, g?.visible ?? null, g?.requests ?? null, g?.chunks?.received ?? null, g?.error ?? null]); }
          // Only an open that started with this one counts (the stats are app-wide).
          if (g && g.allVisibleCrispAt !== null && g.openedAt !== null && g.openedAt >= openBegin - 50)
            return { ...c, timeline, progressLog, gpuLog, gpu: g, gpuReadyMs: g.allVisibleCrispAt - openBegin, gpuState: await gpuState(), jank: await jank() };
        }
        if (!gpu && c.id === fixture.id && c.frames >= fixture.count && c.covered >= fixture.count) return { ...c, timeline, progressLog, jank: await jank() };
        if (!gpu && fixture.count >= 500 && c.id === fixture.id && c.covered > 0 && Date.now() - lastChange > settleMs) return { ...c, timeline, progressLog, settled: true, jank: await jank() };
        if (Date.now() > until) {
          if (fixture.count >= 500 || gpu) return { ...c, timeline, progressLog, gpuLog, gpu: gpu ? await gpuSnapshot() : undefined, gpuState: gpu ? await gpuState() : undefined, timedOut: true, jank: await jank() };
          throw new Error(`Incomplete ${fixture.name} coverage: ${JSON.stringify(c)}`);
        }
        await pause(gpu ? 50 : fixture.count >= 500 ? 200 : 50);
      }
    };
    const fitCamera = fixture => page.evaluate(async ({ id, pageId }) => {
      const { designWorkspaceSnapshotCache } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-cache.ts");
      const snapshot = designWorkspaceSnapshotCache.peekSnapshot(id).data;
      let frames = snapshot.preparation?.descriptions ?? snapshot.frames;
      if (pageId) frames = frames.filter(f => f.pageId === pageId);
      const box = document.querySelector('[data-design-retained-workspace][aria-hidden="false"] [data-design-canvas-viewport]').getBoundingClientRect();
      const left = Math.min(...frames.map(f => f.x)), top = Math.min(...frames.map(f => f.y));
      const zoom = Math.min(.7, (box.width - 64) / (Math.max(...frames.map(f => f.x + f.width)) - left),
        (box.height - 160) / (Math.max(...frames.map(f => f.y + f.height)) - top));
      return { zoom, panX: 32 - left * zoom, panY: 96 - top * zoom };
    }, { id: fixture.id, pageId: fixture.pageId });
    const open = async fixture => {
      const begin = performance.now(), openBegin = Date.now();
      await page.evaluate(async fixture => { const { useWorkspaceStore } = await import("/apps/desktop/src/renderer/state/workspace-store.ts");
        useWorkspaceStore.getState().dispatch({ type: "OPEN_WORKSPACE", folder: fixture.path, repoRoot: fixture.repoRoot, chatId: null }); }, fixture);
      await activateNativeWorkbenchTab(page, fixture.path, "design");
      if (fixture.pageId) {
        await waitForNativeRenderer(page, async id => {
          const { useDesignWorkspaceUiStore } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-ui.ts");
          return Boolean(useDesignWorkspaceUiStore.getState().byWorkspace[id]?.activePageId);
        }, fixture.id, 60_000);
        await page.evaluate(async ({ id, pageId }) => {
          const { useDesignWorkspaceUiStore } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-ui.ts");
          const view = useDesignWorkspaceUiStore.getState().byWorkspace[id];
          if (view.activePageId !== pageId) useDesignWorkspaceUiStore.getState().setActivePage(id, pageId, view.directoryId);
        }, { id: fixture.id, pageId: fixture.pageId });
      }
      await prepareNativeDesignView(page, fixture.id, fixture.camera ?? { zoom: .075, panX: 32, panY: 96 }, 60_000);
      if (!fixture.camera) { fixture.camera = await fitCamera(fixture); await prepareNativeDesignView(page, fixture.id, fixture.camera, 60_000); }
      const coverage = await ready(fixture, undefined, openBegin);
      return { ms: performance.now() - begin, coverage };
    };

    for (const fixture of fixtures) {
      const result = { name: fixture.name, frames: fixture.count };
      report.fixtures.push(result);
      await phase(`${fixture.name}:open`);
      if (profileCold) { await cdp.send("Profiler.enable"); await cdp.send("Profiler.setSamplingInterval", { interval: 500 }); await cdp.send("Profiler.start"); }
      const cold = await open(fixture);
      if (profileCold) { const { profile: cpu } = await cdp.send("Profiler.stop"); await fs.writeFile(path.join(evidence, `${fixture.name}-cold-profile.cpuprofile`), JSON.stringify(cpu)); }
      result.coldReadyMs = cold.ms; result.coverage = cold.coverage; result.opsOpen = await takeOps();
      if (gpu) { result.gpuColdMs = cold.coverage.gpuReadyMs ?? null; result.gpuCold = cold.coverage.gpu ?? null; }
      result.selectionStacks = await page.evaluate(() => globalThis.__benchSelectionStacks ?? []).catch(() => null);
      if (captureDump > 0) {
        // Native captures of real composed frames, one at a time, for the batch-renderer experiment.
        result.captureDump = await page.evaluate(async ({ id, n }) => {
          const { designWorkspaceSnapshotCache } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-cache.ts");
          const { useDesignWorkspaceUiStore } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-ui.ts");
          const { bridgeDesignPreview } = await import("/apps/desktop/src/renderer/platform/bridge/design-bridge.ts");
          const { getActiveBridge } = await import("/apps/desktop/src/renderer/platform/bridge/active-bridge.ts");
          const designPreview = (workspaceId, input, options) => bridgeDesignPreview(getActiveBridge(), workspaceId, input, options);
          let firstError = null;
          const snapshot = designWorkspaceSnapshotCache.peekSnapshot(id).data;
          const pageId = useDesignWorkspaceUiStore.getState().byWorkspace[id]?.activePageId;
          const prepared = snapshot.frames.filter(frame => frame.sourceVersion);
          const onPage = prepared.filter(frame => pageId && frame.pageId === pageId);
          const frames = (onPage.length ? onPage : prepared).slice(0, n);
          const times = [];
          const begin = performance.now();
          for (const frame of frames) {
            const start = performance.now();
            try {
              await designPreview(id, { directoryId: snapshot.directoryId, frame: frame.file, sourceVersion: frame.sourceVersion,
                theme: null, maxDimension: 128 }, { admitted: true });
              times.push(Math.round(performance.now() - start));
            } catch (error) { times.push(-1); firstError ??= String(error?.message ?? error).slice(0, 300); }
          }
          return { frames: frames.length, totalMs: Math.round(performance.now() - begin), times, firstError };
        }, { id: fixture.id, n: captureDump });
        await save();
      }
      await pause(3000);
      { const rows = await sample();
        // Name the processes outside Electron's own metrics (recorder, engine children) and their footprints.
        const others = rows.filter(row => !["Tab", "Browser", "GPU", "Utility", "local-engine"].includes(row.role));
        const names = others.length ? (await run("ps", ["-o", "pid=,comm=", "-p", others.map(row => row.pid).join(",")]).catch(() => ""))
          .split("\n").map(line => line.trim().match(/^(\d+)\s+(.*)$/)).filter(Boolean) : [];
        const byPid = new Map(names.map(match => [Number(match[1]), match[2].split("/").slice(-2).join("/")]));
        result.afterOpen = { renderer: await renderer(), memory: summarize(rows),
          others: others.map(row => ({ pid: row.pid, role: row.role, name: byPid.get(row.pid) ?? "?", mb: Math.round((row.physicalFootprintBytes ?? 0) / 2 ** 20) }))
            .sort((a, b) => b.mb - a.mb).slice(0, 20) }; }
      // Does memory settle once pictures stop arriving? Renderer JS heap vs native, over 30 s idle.
      const heap = async () => { const h = await cdp.send("Runtime.getHeapUsage").catch(() => null);
        return h && { usedMB: Math.round(h.usedSize / 2 ** 20), totalMB: Math.round(h.totalSize / 2 ** 20),
          embedderMB: Math.round((h.embedderHeapUsedSize ?? 0) / 2 ** 20), backingMB: Math.round((h.backingStorageSize ?? 0) / 2 ** 20) }; };
      result.memorySettle = [{ s: 3, heap: await heap(), memory: result.afterOpen.memory }];
      if (memoryDump) result.coldDump = await dumpMemory("after-cold-open");
      for (const s of [15, 30]) { await pause(s === 15 ? 12_000 : 15_000);
        result.memorySettle.push({ s, heap: await heap(), memory: summarize(await sample()) }); }
      await save();
      if (args.includes("--reload-open")) {
        // A renderer reload drops every prepared generation and in-memory picture
        // but keeps the stored ones: the canvas's view right after a restart.
        await phase(`${fixture.name}:reload`);
        await pause(5000);
        await rawPage.reload({ waitUntil: "domcontentloaded" });
        // Bench only: every change to the Design viewport's box and the world's
        // camera transform, one sample per display frame, from the reload on.
        await page.evaluate(() => {
          const log = globalThis.__benchLayoutLog = [];
          const start = performance.now();
          let last = "";
          const tick = () => {
            const viewports = [...document.querySelectorAll("[data-design-canvas-viewport]")].map((element) => {
              const box = element.getBoundingClientRect();
              return `${Math.round(box.width)}x${Math.round(box.height)}@${Math.round(box.left)},${Math.round(box.top)}`;
            }).join("|");
            const worlds = [...document.querySelectorAll("[data-design-canvas-world]")].map((element) => element.style.transform).join("|");
            const key = `${viewports} ${worlds}`;
            if (key !== last) { last = key; log.push([Math.round(performance.now() - start), viewports, worlds]); }
            if (log.length < 400 && performance.now() - start < 10_000) requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }).catch(() => {});
        await waitForNativeRenderer(page, async () =>
          (await import("/apps/desktop/src/renderer/platform/bridge/active-bridge.ts")).getActiveBridge()?.status === "connected", undefined, 60_000);
        // Name every bridge request (op, duration, outcome) after the reload: the
        // diagnostic allowlist reports most Design ops as "other".
        await page.evaluate(async () => {
          const { getActiveBridge } = await import("/apps/desktop/src/renderer/platform/bridge/active-bridge.ts");
          const proto = Object.getPrototypeOf(getActiveBridge());
          if (proto.__benchWrapped) return; proto.__benchWrapped = true;
          const original = proto.request; const ops = globalThis.__benchReloadOps = { done: [], open: new Map(), seq: 0 };
          proto.request = function (msg, ...rest) {
            const id = ++ops.seq, start = performance.now(), op = String(msg?.op ?? msg?.type);
            ops.open.set(id, [op, start]);
            const done = outcome => { ops.open.delete(id); if (ops.done.length < 4000) ops.done.push([op, Math.round(start), Math.round(performance.now() - start), outcome]); };
            const promise = original.call(this, msg, ...rest);
            promise.then(() => done("ok"), error => done(String(error?.message ?? error).slice(0, 80)));
            return promise;
          };
        }).catch(error => { result.reloadHookError = String(error).slice(0, 200); });
        const opsSummary = () => page.evaluate(() => {
          const ops = globalThis.__benchReloadOps; if (!ops) return null;
          const by = {};
          for (const [op, , ms, outcome] of ops.done) { const row = by[op] ??= { n: 0, failed: 0, maxMs: 0, totalMs: 0, lastError: "" };
            row.n++; row.totalMs += ms; row.maxMs = Math.max(row.maxMs, ms); if (outcome !== "ok") { row.failed++; row.lastError = outcome; } }
          return { by, open: [...ops.open.values()].map(([op, start]) => `${op}:${Math.round(performance.now() - start)}ms`) };
        }).catch(() => null);
        const diagnose = () => page.evaluate(async ({ id, folder }) => {
          const { designWorkspaceSnapshotCache } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-cache.ts");
          const { useDesignWorkspaceUiStore } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-ui.ts");
          const read = designWorkspaceSnapshotCache.peekSnapshot(id);
          const view = useDesignWorkspaceUiStore.getState().byWorkspace[id];
          const { useWorkspaceStore } = await import("/apps/desktop/src/renderer/state/workspace-store.ts");
          const ws = useWorkspaceStore.getState();
          const scope = ws.workbenchByScope?.[folder];
          return { store: { activePage: ws.activePage, lastWorkspaceFolder: ws.lastWorkspaceFolder === folder ? "fixture" : String(ws.lastWorkspaceFolder).slice(-40),
            activeChatId: ws.activeChatId ? "set" : null, newAgentFolder: ws.newAgentFolder === folder ? "fixture" : ws.newAgentFolder,
            activeTab: scope?.activeId ?? null, tabs: scope?.tabs?.map(tab => tab.type) },
            read: { status: read.status, loading: read.loading, refreshing: read.refreshing, error: String(read.error ?? "").slice(0, 300),
            directoryId: read.data?.directoryId, descriptions: read.data?.preparation?.descriptions?.length, frames: read.data?.frames?.length },
            view: view ? { directoryId: view.directoryId, activePageId: view.activePageId } : null,
            retained: [...document.querySelectorAll("[data-design-retained-workspace]")].map(e => [e.getAttribute("data-design-retained-workspace"), e.getAttribute("aria-hidden")]),
            keys: designWorkspaceSnapshotCache.keys?.(),
            bridge: await (async () => { const bridge = (await import("/apps/desktop/src/renderer/platform/bridge/active-bridge.ts")).getActiveBridge();
              return bridge ? { status: bridge.status, queued: bridge.queuedRequests?.length ?? null,
                pending: [...(bridge.pendingRequests?.values?.() ?? [])].map(p => `${p.diagnostic?.requestType}/${p.diagnostic?.operation}:${Math.round(performance.now() - p.startedAt)}ms`).slice(0, 40) } : null; })() };
        }, { id: fixture.id, folder: fixture.path }).catch(error => ({ error: String(error) }));
        // The app restores its last session after a reload; let that settle
        // before the fixture's tab is activated again.
        await pause(8000);
        // A reloaded renderer re-reads its projects; adopt the fixture again
        // (same folder, same workspace identity) as the first open did.
        const reloadedId = await adopt(fixture);
        assert.equal(reloadedId, fixture.id, "The fixture's workspace identity changed across the reload.");
        await prepareNativeWorkspaceCatalog(page, [{ folder: fixture.path, workspaceId: fixture.id }]);
        result.reloadBefore = await diagnose();
        let reopened;
        const engineCpu = async () => (await run("ps", ["-o", "%cpu=,rss=", "-p", String(enginePid)]).catch(() => "gone")).trim();
        try { reopened = await open(fixture); }
        catch (error) {
          // Record the stall, then wait longer: a read that lands late is slow, one that never does is stuck.
          result.reloadFailure = { error: String(error).slice(0, 300), state: await diagnose(), samples: [] };
          await save();
          const begin = performance.now();
          for (let i = 0; i < 24; i++) {
            const state = await diagnose();
            result.reloadFailure.samples.push({ s: Math.round((performance.now() - begin) / 1000), engine: await engineCpu(),
              loading: state.read?.loading, frames: state.read?.frames, ops: await opsSummary() });
            await save();
            if (!state.read?.loading && state.read?.frames) break;
            await pause(10_000);
          }
          result.reloadFailure.lateMs = performance.now() - begin;
          reopened = await open(fixture);
        }
        result.reloadReadyMs = reopened.ms; result.reloadCoverage = reopened.coverage; result.reloadOps = await opsSummary();
        result.reloadLayout = await page.evaluate(() => globalThis.__benchLayoutLog ?? null).catch(() => null);
        result.reloadOpsTimeline = await page.evaluate(() => (globalThis.__benchReloadOps?.done ?? [])
          .filter(([op]) => op.startsWith("design.")).slice(0, 200)).catch(() => null);
        if (gpu) { result.gpuReloadMs = reopened.coverage.gpuReadyMs ?? null; result.gpuReload = reopened.coverage.gpu ?? null; }
        result.enginePidsAfterReload = (await run("ps", ["-axo", "pid=,ppid=,comm="])).split("\n").map(row => row.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
          .filter(row => row && Number(row[2]) === mainPid && row[3].includes("zeros-engine-")).map(row => Number(row[1]));
        result.afterReload = { renderer: await renderer(), memory: summarize(await sample()) };
        await save();
      }
      if (memoryDump) result.afterOpen.dump = await dumpMemory("after-open");
      await save();

      await phase(`${fixture.name}:idle-visible`);
      if (profileOpen) { await cdp.send("Profiler.enable"); await cdp.send("Profiler.setSamplingInterval", { interval: 500 }); await cdp.send("Profiler.start"); }
      await ensureVisible(fixture);
      if (!skip.has("idle")) result.idleVisible = await cpuWindow("idle-visible", idleSeconds);
      result.idleVisibleStillVisible = await page.evaluate(() => document.visibilityState);
      if (profileOpen) { const { profile: cpu } = await cdp.send("Profiler.stop"); await fs.writeFile(path.join(evidence, `${fixture.name}-idle-profile.cpuprofile`), JSON.stringify(cpu)); }
      await save();

      await phase(`${fixture.name}:gestures`);
      result.gestures = [];
      // Working zoom (100%, on the page's first frame) next to fit: where a
      // designer actually draws, and where the recorded canvas redraws vectors.
      const working = gpu ? await page.evaluate(async ({ id, pageId }) => {
        const { designWorkspaceSnapshotCache } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-cache.ts");
        const snapshot = designWorkspaceSnapshotCache.peekSnapshot(id).data;
        let frames = snapshot.preparation?.descriptions ?? snapshot.frames;
        if (pageId) frames = frames.filter(f => f.pageId === pageId);
        const first = [...frames].sort((a, b) => a.y - b.y || a.x - b.x)[0];
        return { zoom: 1, panX: 32 - first.x, panY: 96 - first.y };
      }, { id: fixture.id, pageId: fixture.pageId }) : null;
      const gestureNames = gpu ? ["pan", "zoom", "pan100", "zoom100"] : ["pan", "zoom"];
      for (let repeat = 1; repeat <= reps; repeat++) for (const gestureName of gestureNames) {
        const name = gestureName.replace("100", ""), camera = gestureName.endsWith("100") ? working : fixture.camera;
        await ensureVisible(fixture);
        await prepareNativeDesignView(page, fixture.id, camera); await pause(gpu ? 2500 : 1200);
        const gpuBefore = gpu ? await gpuSnapshot() : null;
        if (gpu) await gpuReset();
        await ensureVisible(fixture);
        const box = await page.locator(viewportSelector).boundingBox(), events = [];
        const collect = data => events.push(...data.value); cdp.on("Tracing.dataCollected", collect);
        const complete = new Promise(resolve => cdp.once("Tracing.tracingComplete", resolve));
        const prefix = `zeros:design:${gestureName}:${repeat}`;
        const visible = await page.evaluate(() => document.visibilityState);
        await cdp.send("Tracing.start", { categories: detailTrace && repeat === 1
          ? "benchmark,input,blink.user_timing,disabled-by-default-devtools.timeline.frame,toplevel,cc,viz,gpu,devtools.timeline,disabled-by-default-cc.debug.scheduler,disabled-by-default-cc.debug.scheduler.frames,v8.execute,blink" + (args.includes("--invalidation-trace") ? ",disabled-by-default-devtools.timeline.invalidationTracking" : "")
          : "benchmark,input,blink.user_timing,disabled-by-default-devtools.timeline.frame", transferMode: "ReportEvents" });
        await startNativeDesignCameraObservation(page, prefix);
        const profiling = profile && repeat === 1;
        if (profiling) { await cdp.send("Profiler.enable"); await cdp.send("Profiler.setSamplingInterval", { interval: 250 }); await cdp.send("Profiler.start"); }
        const window = await cpuWindow(`${name}-${repeat}`, 0, async () => {
          if (nativeGestures) {
            const bounds = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentBounds());
            assert(!gestureName.endsWith("100"), "Native gestures cover fit only.");
            await app.evaluate(({ app, BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setIgnoreMouseEvents(false); w.show(); w.focus(); app.focus({ steal: true }); });
            const { dispatchMacDesignGesture } = await import("./design-native-input.mjs");
            result.lastInput = await dispatchMacDesignGesture({ pid: mainPid, name, startZoom: camera.zoom,
              x: bounds.x + box.x + box.width / 2, y: bounds.y + box.y + box.height / 2, steps: 480 }, { signal: controller.signal });
            await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setIgnoreMouseEvents(true));
          } else if (inputMode === "synth") {
            const x = box.x + box.width / 2, y = box.y + box.height / 2, started = performance.now();
            const bounded = (request, ms) => Promise.race([request, delay(ms).then(() => {
              throw new Error("Synthetic gesture produced no frames (window occluded or display asleep)."); })]);
            const visibility = await page.evaluate(() => document.visibilityState);
            if (visibility !== "visible") throw new Error(`Bench window is ${visibility}; gestures need a visible window.`);
            if (name === "pan") for (let leg = 0; leg < 4; leg++)
              await bounded(cdp.send("Input.synthesizeScrollGesture", { x, y, xDistance: leg % 2 ? 400 : -400, yDistance: leg % 2 ? 300 : -300,
                speed: 800, gestureSourceType: "mouse", repeatCount: 0 }), 15_000);
            else for (const scaleFactor of gestureName === "zoom100" ? [2, 2, .5, .5] : [4, 4, .25, .25])
              await bounded(cdp.send("Input.synthesizePinchGesture", { x, y, scaleFactor, relativeSpeed: 400, gestureSourceType: "mouse" }), 20_000);
            result.lastInput = { mode: "synth", durationMs: performance.now() - started };
          } else result.lastInput = await dispatchNativeDesignGesture(cdp, { name, startZoom: camera.zoom,
            x: box.x + box.width / 2, y: box.y + box.height / 2, steps: 480, rateHz: 120 });
        });
        if (profiling) { const { profile: cpu } = await cdp.send("Profiler.stop"); await fs.writeFile(path.join(evidence, `${fixture.name}-${name}-profile.cpuprofile`), JSON.stringify(cpu)); }
        const cameraChanges = await finishNativeDesignCameraObservation(page, prefix);
        await pause(300); await cdp.send("Tracing.end"); await complete; cdp.off("Tracing.dataCollected", collect);
        await fs.writeFile(path.join(evidence, `${fixture.name}-${name}-${repeat}-trace.json`), JSON.stringify({ traceEvents: events }));
        const first = events.find(e => e.name === prefix + ":start"), last = events.find(e => e.name === prefix + ":end");
        let presentation = null;
        try { presentation = analyzeDesignPresentationTrace(events, { rendererPid: first.pid, startUs: first.ts, endUs: last.ts }); }
        catch (error) { presentation = { error: String(error.message ?? error) }; }
        let gpuGesture = null;
        if (gpu) {
          const during = await gpuSnapshot();
          // After the gesture: how long until every visible frame is drawn at the camera's own density again.
          const settleBegin = Date.now(); let settled = null, last = null;
          while (Date.now() - settleBegin < 15_000) {
            last = await gpuSnapshot();
            const v = last?.visible;
            if (v && v.frames > 0 && v.stretched === 0 && v.finer === 0 && v.missing === 0) { settled = Date.now() - settleBegin; break; }
            await pause(50);
          }
          gpuGesture = { before: gpuBefore && { visible: gpuBefore.visible }, draw: during?.draw, bursts: during?.bursts, upload: during?.upload,
            visibleAtEnd: during?.visible, crispAfterMs: settled, visibleSettled: last?.visible, worker: last?.worker && { raster: last.worker.raster,
              deserialize: last.worker.deserialize, wasmHeapBytes: last.worker.wasmHeapBytes }, gpuBytes: last?.gpu?.bytes };
        }
        result.gestures.push({ name: gestureName, repeat, visible, cameraChanges, input: result.lastInput, presentation, cpu: window, gpu: gpuGesture });
        await save();
      }
      await prepareNativeDesignView(page, fixture.id, fixture.camera); await pause(2000);
      result.afterGestures = { renderer: await renderer(), memory: summarize(await sample()) };

      // Recorded vs live: each sampled frame at 100%, first drawn from its
      // recording, then by its own live document (selected), diffed inside
      // its edges so the selection stroke doesn't count.
      const fidelityCount = Number(option(args, "--fidelity", "0"));
      if (gpu && fidelityCount > 0) {
        await phase(`${fixture.name}:fidelity`);
        const targets = await page.evaluate(async ({ id, pageId, n }) => {
          const { designWorkspaceSnapshotCache } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-cache.ts");
          const snapshot = designWorkspaceSnapshotCache.peekSnapshot(id).data;
          let frames = snapshot.preparation?.descriptions ?? snapshot.frames;
          if (pageId) frames = frames.filter(f => f.pageId === pageId);
          // One frame per distinct size: the replica repeats designs.
          const seen = new Set(), out = [];
          for (const f of [...frames].sort((a, b) => a.y - b.y || a.x - b.x)) {
            const key = `${f.width}x${f.height}`;
            if (seen.has(key) && out.length >= n / 2) continue;
            seen.add(key); out.push({ file: f.file, x: f.x, y: f.y, width: f.width, height: f.height });
            if (out.length >= n) break;
          }
          return out;
        }, { id: fixture.id, pageId: fixture.pageId, n: fidelityCount });
        const box = await page.locator(viewportSelector).boundingBox();
        const diffs = [];
        for (const target of targets) {
          const camera = { zoom: 1, panX: 32 - target.x, panY: 96 - target.y };
          await prepareNativeDesignView(page, fixture.id, camera);
          const settleBegin = Date.now();
          while (Date.now() - settleBegin < 8_000) {
            const v = (await gpuSnapshot())?.visible;
            if (v && v.frames > 0 && v.stretched === 0 && v.finer === 0 && v.missing === 0) break;
            await pause(50);
          }
          await pause(300);
          const inset = 12;
          const clip = { x: box.x + 32 + inset, y: box.y + 96 + inset,
            width: Math.max(1, Math.min(target.width, box.width - 32) - inset * 2), height: Math.max(1, Math.min(target.height, box.height - 96) - inset * 2) };
          const recorded = await rawPage.screenshot({ clip, scale: "device" });
          await page.evaluate(async ({ id, file }) => {
            const { useDesignWorkspaceUiStore } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-ui.ts");
            useDesignWorkspaceUiStore.getState().setSelectedTargets(id, [{ frame: file }], { activeFrame: file, explicit: true });
          }, { id: fixture.id, file: target.file });
          let live = null, liveError = null;
          try {
            await page.locator(`[data-design-retained-workspace="${fixture.id}"][aria-hidden="false"] [data-design-frame=${JSON.stringify(target.file)}] iframe[data-design-document-buffer="displayed"][data-design-document-ready]`).waitFor({ timeout: 20_000 });
            await pause(600);
            live = await rawPage.screenshot({ clip, scale: "device" });
          } catch (error) { liveError = String(error?.message ?? error).slice(0, 160); }
          await page.evaluate(async id => {
            const { useDesignWorkspaceUiStore } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-ui.ts");
            useDesignWorkspaceUiStore.getState().setSelectedTargets(id, [], { activeFrame: null, explicit: true });
          }, fixture.id);
          if (!live) { diffs.push({ file: target.file, error: liveError }); continue; }
          const name = target.file.replace(/[^a-z0-9]+/gi, "_").slice(-60);
          await fs.writeFile(path.join(evidence, `fidelity-${name}-recorded.png`), recorded);
          await fs.writeFile(path.join(evidence, `fidelity-${name}-live.png`), live);
          diffs.push({ file: target.file, ...(await page.evaluate(async ({ a, b }) => {
            const decode = async (base64) => { const image = new Image(); image.src = `data:image/png;base64,${base64}`; await image.decode();
              const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
              const context = canvas.getContext("2d"); context.drawImage(image, 0, 0); return context.getImageData(0, 0, image.width, image.height); };
            const [x, y] = await Promise.all([decode(a), decode(b)]);
            if (x.width !== y.width || x.height !== y.height) return { error: "size" };
            let differing = 0, strong = 0;
            for (let i = 0; i < x.data.length; i += 4) {
              const d = Math.max(Math.abs(x.data[i] - y.data[i]), Math.abs(x.data[i + 1] - y.data[i + 1]), Math.abs(x.data[i + 2] - y.data[i + 2]));
              if (d > 16) differing++;
              if (d > 96) strong++;
            }
            const pixels = x.width * x.height;
            return { width: x.width, height: x.height, differing: differing / pixels, strong: strong / pixels };
          }, { a: recorded.toString("base64"), b: live.toString("base64") })) });
          await save();
        }
        result.fidelity = diffs;
        await prepareNativeDesignView(page, fixture.id, fixture.camera); await pause(1000);
      }
      await save();

      // Inspecting: panels open, select frames in turn, sweep the pointer over
      // each selected frame (hover outlines), then measure the settled cost.
      if (!skip.has("inspect")) {
      await phase(`${fixture.name}:inspect`);
      await ensureVisible(fixture);
      await page.evaluate(async id => {
        const { useDesignWorkspaceUiStore } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-ui.ts");
        useDesignWorkspaceUiStore.getState().setPanels(id, { layersVisible: true, inspectorVisible: true });
      }, fixture.id);
      await pause(1500);
      const files = await page.evaluate(id => [...document.querySelectorAll(`[data-design-retained-workspace="${id}"][aria-hidden="false"] [data-design-frame]`)]
        .map(frame => frame.getAttribute("data-design-frame")), fixture.id);
      const chosen = files.filter((_, i) => i % Math.max(1, Math.floor(files.length / inspectCount)) === 0).slice(0, inspectCount);
      const selections = [];
      await takeOps();
      if (profile) { await cdp.send("Profiler.enable"); await cdp.send("Profiler.setSamplingInterval", { interval: 250 }); await cdp.send("Profiler.start"); }
      const inspectWindow = await cpuWindow("inspect-sequence", 0, async () => {
        for (const file of chosen) {
          const begin = performance.now();
          await page.evaluate(async ({ id, file }) => {
            const { useDesignWorkspaceUiStore } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-ui.ts");
            useDesignWorkspaceUiStore.getState().setSelectedTargets(id, [{ frame: file }], { activeFrame: file, explicit: true });
          }, { id: fixture.id, file });
          let readyMs = null;
          try {
            await page.locator(`[data-design-retained-workspace="${fixture.id}"][aria-hidden="false"] [data-design-frame=${JSON.stringify(file)}] iframe[data-design-document-buffer="displayed"][data-design-document-ready]`).waitFor({ timeout: 20_000 });
            readyMs = performance.now() - begin;
          } catch { readyMs = null; }
          const frameBox = await page.locator(`[data-design-retained-workspace="${fixture.id}"][aria-hidden="false"] [data-design-frame=${JSON.stringify(file)}]`).boundingBox().catch(() => null);
          if (frameBox) for (let i = 0; i < 40; i++) {
            await rawPage.mouse.move(frameBox.x + frameBox.width * (0.1 + 0.8 * (i % 20) / 20), frameBox.y + frameBox.height * (0.2 + 0.6 * Math.floor(i / 20)));
            await pause(16);
          }
          selections.push({ file, readyMs });
        }
      });
      if (profile) { const { profile: cpu } = await cdp.send("Profiler.stop"); await fs.writeFile(path.join(evidence, `${fixture.name}-inspect-profile.cpuprofile`), JSON.stringify(cpu)); }
      const inspectOps = await takeOps();
      result.inspect = { ops: inspectOps, selections, readyP50: percentile(selections.map(s => s.readyMs).filter(Number.isFinite), 50),
        readyMax: percentile(selections.map(s => s.readyMs).filter(Number.isFinite), 100), failed: selections.filter(s => s.readyMs === null).length,
        sequence: inspectWindow };
      result.inspect.idleSelected = await cpuWindow("idle-inspecting", idleSeconds);
      result.inspect.after = { renderer: await renderer(), memory: summarize(await sample()) };
      await page.evaluate(async id => {
        const { useDesignWorkspaceUiStore } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-ui.ts");
        useDesignWorkspaceUiStore.getState().setSelectedTargets(id, [], { activeFrame: null, explicit: true });
        useDesignWorkspaceUiStore.getState().setPanels(id, { layersVisible: false, inspectorVisible: false });
      }, fixture.id);
      await save();
      }

      // Agents editing frames on disk while the page is open: per-edit time to
      // a new generation and a new picture, plus CPU and main-thread hitches.
      // Every touched file gets its original bytes back before the next phase.
      const agentWrites = Number(option(args, "--agent-writes", "0"));
      if (agentWrites > 0) {
        await phase(`${fixture.name}:agent-writes`);
        await ensureVisible(fixture);
        // Edits land where the user looks: the fitted page, every frame visible.
        await prepareNativeDesignView(page, fixture.id, fixture.camera); await pause(1500);
        const chosen = await page.evaluate(async ({ id, n }) => {
          const { designWorkspaceSnapshotCache } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-cache.ts");
          const snapshot = designWorkspaceSnapshotCache.peekSnapshot(id).data;
          const shown = [...document.querySelectorAll(`[data-design-retained-workspace="${id}"][aria-hidden="false"] [data-design-frame]`)]
            .map(element => element.getAttribute("data-design-frame"));
          const prepared = new Map(snapshot.frames.filter(frame => frame.sourceVersion).map(frame => [frame.file, frame.sourceVersion]));
          const files = shown.filter(file => prepared.has(file));
          const step = Math.max(1, Math.floor(files.length / n));
          return { directory: snapshot.directory, directoryId: snapshot.directoryId,
            frames: files.filter((_, index) => index % step === 0).slice(0, n).map(file => ({ file, sourceVersion: prepared.get(file) })) };
        }, { id: fixture.id, n: agentWrites });
        const originals = new Map();
        const rows = chosen.frames.map(frame => ({ ...frame, writtenAt: null, preparedMs: null, picturedMs: null }));
        const statusOf = () => page.evaluate(async ({ id, directoryId, files }) => {
          const { designWorkspaceSnapshotCache } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-cache.ts");
          const { designFramePreviews } = await import("/apps/desktop/src/renderer/features/design-workspace/state/use-design-frame-previews.ts");
          const snapshot = designWorkspaceSnapshotCache.peekSnapshot(id).data;
          const versions = new Map((snapshot?.frames ?? []).map(frame => [frame.file, frame.sourceVersion]));
          const owner = { scope: "local", workspaceId: id, directoryId };
          const themes = [null, ...((snapshot?.themes ?? []).map(theme => theme?.name ?? theme?.id ?? theme).filter(value => typeof value === "string"))];
          return files.map(file => { const version = versions.get(file) ?? null;
            return [version, !!version && themes.some(theme => designFramePreviews.pictured(owner, theme, [{ file, sourceVersion: version }]).size > 0)]; });
        }, { id: fixture.id, directoryId: chosen.directoryId, files: rows.map(row => row.file) })
          .catch(error => { probeError ??= String(error?.message ?? error).slice(0, 240); return null; });
        let probeError = null;
        await page.evaluate(() => { globalThis.__benchWriteLoaf?.disconnect?.();
          const stats = globalThis.__benchWriteLoafStats = { count: 0, maxMs: 0, over100: 0, blockingMs: 0 };
          const observer = new PerformanceObserver(list => { for (const entry of list.getEntries()) { stats.count++;
            stats.maxMs = Math.max(stats.maxMs, entry.duration); if (entry.duration > 100) stats.over100++; stats.blockingMs += entry.blockingDuration ?? 0; } });
          observer.observe({ type: "long-animation-frame" }); globalThis.__benchWriteLoaf = observer; }).catch(() => {});
        const intervalMs = Number(option(args, "--agent-interval", "400"));
        const profileWrites = args.includes("--profile-writes");
        if (profileWrites) { await cdp.send("Profiler.enable"); await cdp.send("Profiler.setSamplingInterval", { interval: 250 }); await cdp.send("Profiler.start"); }
        try {
          result.agentWrites = { frames: rows.length, intervalMs };
          result.agentWrites.cpu = await cpuWindow("agent-writes", 0, async () => {
            const begin = performance.now();
            let next = 0;
            while (performance.now() - begin < rows.length * intervalMs + 60_000) {
              if (next < rows.length && performance.now() - begin >= next * intervalMs) {
                const row = rows[next++];
                const file = path.join(fixture.path, chosen.directory, row.file);
                const bytes = await fs.readFile(file, "utf8");
                originals.set(file, bytes);
                const at = bytes.lastIndexOf("</body>");
                await fs.writeFile(file, at >= 0 ? `${bytes.slice(0, at)}<!-- bench agent edit ${next} -->${bytes.slice(at)}` : `${bytes}<!-- bench agent edit ${next} -->`);
                row.writtenAt = performance.now();
              }
              const status = await statusOf();
              if (status) status.forEach(([version, pictured], index) => {
                const row = rows[index];
                if (row.writtenAt === null || !version || version === row.sourceVersion) return;
                row.preparedMs ??= Math.round(performance.now() - row.writtenAt);
                if (pictured) row.picturedMs ??= Math.round(performance.now() - row.writtenAt);
              });
              if (next >= rows.length && rows.every(row => row.picturedMs !== null)) break;
              await pause(100);
            }
          });
        } finally {
          for (const [file, bytes] of originals) await fs.writeFile(file, bytes);
          if (profileWrites) { const { profile: cpu } = await cdp.send("Profiler.stop");
            await fs.writeFile(path.join(evidence, `${fixture.name}-agent-writes-profile.cpuprofile`), JSON.stringify(cpu)); }
        }
        result.agentWrites.jank = await page.evaluate(() => { const stats = globalThis.__benchWriteLoafStats; globalThis.__benchWriteLoaf?.disconnect?.();
          return stats ? { ...stats, maxMs: Math.round(stats.maxMs), blockingMs: Math.round(stats.blockingMs) } : null; }).catch(() => null);
        const quantile = (values, q) => { const sorted = values.filter(value => value !== null).sort((a, b) => a - b);
          return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : null; };
        result.agentWrites.prepared = { p50: quantile(rows.map(row => row.preparedMs), 0.5), p95: quantile(rows.map(row => row.preparedMs), 0.95),
          missing: rows.filter(row => row.preparedMs === null).length };
        result.agentWrites.pictured = { p50: quantile(rows.map(row => row.picturedMs), 0.5), p95: quantile(rows.map(row => row.picturedMs), 0.95),
          missing: rows.filter(row => row.picturedMs === null).length };
        result.agentWrites.rows = rows.map(({ file, preparedMs, picturedMs }) => [file, preparedMs, picturedMs]);
        result.agentWrites.probeError = probeError;
        // The restored bytes bring the original generations back before the next phase.
        const restoreBegin = performance.now();
        while (performance.now() - restoreBegin < 30_000) {
          const status = await statusOf();
          if (status && status.every(([version], index) => version === rows[index].sourceVersion)) break;
          await pause(250);
        }
        result.agentWrites.restoredMs = Math.round(performance.now() - restoreBegin);
        await save();
      }
      if (skip.has("hidden")) continue;

      await phase(`${fixture.name}:hidden`);
      // The canvas's stats are app-wide and an open keys on the page, so a
      // return to the same page restarts timing only after a reset made while
      // its scene is still mounted.
      if (gpu) await gpuReset();
      await activateNativeWorkbenchTab(page, fixture.path, "files");
      await pause(3000);
      result.idleHidden = await cpuWindow("idle-hidden", idleSeconds);
      result.afterHidden = { renderer: await renderer(), memory: summarize(await sample()) };
      await save();
      // Warm reopen.
      await phase(`${fixture.name}:warm`);
      if (profileOpen) { await cdp.send("Profiler.enable"); await cdp.send("Profiler.setSamplingInterval", { interval: 250 }); await cdp.send("Profiler.start"); }
      const warm = await open(fixture); result.warmReadyMs = warm.ms;
      if (gpu) { result.gpuWarmMs = warm.coverage.gpuReadyMs ?? null; result.gpuWarm = warm.coverage.gpu ?? null; }
      if (profileOpen) { const { profile: cpu } = await cdp.send("Profiler.stop"); await fs.writeFile(path.join(evidence, `${fixture.name}-warm-profile.cpuprofile`), JSON.stringify(cpu)); }
      await pause(2000);
      await activateNativeWorkbenchTab(page, fixture.path, "files");
      await save();
    }
    processes = nativeApplicationProcessIdentities(app);
    await phase("closing");
    await app.close(); app = undefined;
    report.retirement = await waitForNativeProcessRetirement(processes, { requiredPids: [mainPid, enginePid], timeoutMs: 20_000 }).catch(e => ({ error: String(e) }));
    report.finishedAt = new Date().toISOString();
    report.inputMode = inputMode;
    await phase("complete");
    if (cleanup) for (const name of ["app", "vite-cache", "fixtures"]) await fs.rm(path.join(evidence, name), { recursive: true, force: true });
    // The isolated account-free profile this run created (exact slug only).
    if (cleanup && !args.includes("--keep-profile") && /^canvas-bench-[a-f0-9]{6}$/.test(identity.slug))
      await fs.rm(path.join(os.homedir(), "Library/Application Support", `com.zeros.local.${identity.slug}`), { recursive: true, force: true });
    if (cleanup) for (const file of await fs.readdir(evidence)) if (file.endsWith("-trace.json")) await fs.rm(path.join(evidence, file), { force: true });
  } catch (error) {
    report.error = String(error?.stack ?? error);
    await phase("failed");
    process.exitCode = 1;
  } finally {
    clearTimeout(deadline);
    if (app) await app.close().catch(() => {});
    if (server) await server.close().catch(() => {});
    // Failed runs reclaim their build and traces too: the disk guard is 4 GiB.
    if (cleanup && report.stage !== "complete") {
      for (const name of ["app", "vite-cache", "fixtures"]) await fs.rm(path.join(evidence, name), { recursive: true, force: true }).catch(() => {});
      for (const file of await fs.readdir(evidence).catch(() => [])) if (file.endsWith("-trace.json")) await fs.rm(path.join(evidence, file), { force: true }).catch(() => {});
    }
  }
}

main().catch(error => { console.error(error); process.exit(1); });
