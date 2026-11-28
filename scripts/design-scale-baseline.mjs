#!/usr/bin/env node
// Focused scale baseline for Zeros Local Design. Measurement-only: fixtures,
// profiles, builds and traces are isolated under the output directory.
// Usage: node scripts/design-scale-baseline.mjs --source "<zeros-design-demo Design dir>" [--counts 100,500,1000] [--output DIR] [--reopen]
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { launchNativeElectron } from "./design-native-electron.mjs";
import { localEnvironment, pickLocalPorts } from "./electron-local.mjs";
import { writeNativeJson } from "./design-native-run.mjs";
import { runNativeRendererAction, waitForNativeRenderer } from "./design-native-renderer.mjs";
import { activateNativeWorkbenchTab } from "./design-native-workbench.mjs";
import { sampleNativeApplicationMemory } from "./design-native-memory.mjs";
import { nativeViteConfiguration } from "./design-native-vite.mjs";
import { analyzeDesignPresentationTrace } from "./design-performance-budget.mjs";
import {
  dispatchNativeDesignGesture,
  finishNativeDesignCameraObservation,
  prepareNativeDesignView,
  startNativeDesignCameraObservation,
} from "./design-native-view.mjs";

const exec = promisify(execFile);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argument = name => {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
};
const counts = (argument("--counts") ?? "100,500,1000").split(",").map(value => {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 1 || count > 1000) throw new Error("Use --counts with integers from 1 through 1000.");
  return count;
});
assert.deepEqual([...new Set(counts)].sort((a, b) => a - b), [...counts].sort((a, b) => a - b), "Frame counts must be unique.");
assert.equal(process.platform, "darwin", "The native scale baseline requires macOS.");
const source = path.resolve(argument("--source") ?? path.join(repo, "..", "zeros-design-demo", "zeros-design-demo - Design"));
const output = path.resolve(argument("--output") ?? path.join(repo, ".context", `design-scale-baseline-${new Date().toISOString().replace(/[:.]/g, "-")}`));
const keepApp = process.argv.includes("--keep-app");
const reopen = process.argv.includes("--reopen");
if (await fs.stat(output).then(() => true, () => false) && (await fs.readdir(output)).length)
  throw new Error(`Output directory is not empty: ${output}. Choose a new output directory so an existing baseline is preserved.`);
await fs.mkdir(output, { recursive: true });

const run = async (command, args, options = {}) => (await exec(command, args, { cwd: repo, timeout: 120_000, maxBuffer: 8 * 1024 * 1024, ...options })).stdout;
async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
const megabytes = value => Number.isFinite(value) ? Math.round(value / 1024 ** 2 * 10) / 10 : null;
const milliseconds = value => Math.round(value * 10) / 10;

async function makeFixture(count) {
  const folder = path.join(output, `fixture-${count}`);
  const stdout = await run("bun", [
    "scripts/design-performance-fixture.ts",
    "--pages", "2",
    "--frames-per-page", String(count),
    "--layout", "grid",
    "--source", source,
    "--output", folder,
  ], { timeout: 300_000 });
  const designDirectory = path.join(folder, "Zeros Design");
  const canvasFile = path.join(designDirectory, "meta", "canvas.json");
  const canvas = JSON.parse(await fs.readFile(canvasFile, "utf8"));
  const htmlFrames = Object.values(canvas.frames).filter(frame => frame.kind === "html" && frame.source.endsWith(".html"));
  let empty = 0;
  for (const [index, frame] of htmlFrames.entries()) {
    if (index % 4 !== 0) continue;
    await fs.writeFile(path.join(designDirectory, frame.source), `<!doctype html><html><head><link rel="stylesheet" href="../tokens.css"></head><body style="background:transparent !important"><main data-oid="scale-empty-${index}" style="width:100%;height:100%"></main></body></html>\n`);
    empty++;
  }
  const bounds = Object.values(canvas.frames).reduce((box, frame) => ({
    width: Math.max(box.width, frame.x + frame.width),
    height: Math.max(box.height, frame.y + frame.height),
  }), { width: 1, height: 1 });
  const frameBytes = (await Promise.all(htmlFrames.map(frame => fs.stat(path.join(designDirectory, frame.source)))))
    .reduce((sum, stat) => sum + stat.size, 0);
  await run("git", ["-C", folder, "add", "."]);
  await run("git", ["-C", folder, "-c", "user.name=Scale Baseline", "-c", "user.email=scale-baseline@example.invalid", "commit", "-m", "Scale fixture"]);
  const branchName = (await run("git", ["-C", folder, "symbolic-ref", "--short", "HEAD"])).trim();
  return {
    id: String(count), count, folder, branchName, bounds, frameBytes,
    rich: htmlFrames.length - empty, empty,
    pages: canvas.pages.map(page => ({ id: page.id, title: page.title, frames: page.frames.length, files: page.frames.map(id => canvas.frames[id]?.source).filter(Boolean) })),
    generator: JSON.parse(stdout.slice(stdout.indexOf("{"))),
  };
}

function summarizeMemory(rows, previous, elapsedSeconds) {
  const byPid = new Map((previous ?? []).map(row => [row.pid, row]));
  const role = wanted => rows.filter(row => wanted.includes(row.role));
  const sumBytes = key => rowsForRole => rowsForRole.some(row => row[key] === null || row[key] === undefined)
    ? null : rowsForRole.reduce((sum, row) => sum + row[key], 0);
  const summarize = rowsForRole => ({
    rssMiB: megabytes(sumBytes("rssBytes")(rowsForRole)),
    physicalMiB: megabytes(sumBytes("physicalFootprintBytes")(rowsForRole)),
    cpuPercent: rowsForRole.reduce((sum, row) => {
      const before = byPid.get(row.pid);
      return sum + (before && Number.isFinite(row.cpuSeconds) && Number.isFinite(before.cpuSeconds)
        ? Math.max(0, row.cpuSeconds - before.cpuSeconds) / elapsedSeconds * 100 : 0);
    }, 0),
    processes: rowsForRole.length,
  });
  return {
    renderer: summarize(role.call(null, ["Tab"])),
    gpu: summarize(role.call(null, ["GPU"])),
    engine: summarize(role.call(null, ["local-engine"])),
    browser: summarize(role.call(null, ["Browser"])),
    all: summarize(rows),
  };
}

function summarizeCpuProfile(profile) {
  if (!profile?.nodes?.length || !Array.isArray(profile.samples) || profile.samples.length < 2) return [];
  const nodes = new Map(profile.nodes.map(node => [node.id, node]));
  const durationMs = Math.max(1, profile.endTime - profile.startTime) / 1000;
  const rows = new Map();
  for (const id of profile.samples) {
    const node = nodes.get(id);
    if (!node) continue;
    const frame = node.callFrame;
    const url = (frame.url || "").replace(/^https?:\/\/[^/]+/, "").split("?", 1)[0];
    if (!url || url === "pptr:internal") continue;
    const key = `${frame.functionName || "(anonymous)"} ${url}:${(frame.lineNumber ?? 0) + 1}`;
    rows.set(key, (rows.get(key) ?? 0) + 1);
  }
  return [...rows.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([frame, samples]) => ({
    frame, samples, estimatedSelfMs: Math.round(samples / profile.samples.length * durationMs * 10) / 10,
  }));
}

async function waitForProcessExit(pid, timeoutMs = 10_000) {
  if (!pid) return;
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    assert(performance.now() < deadline, `Process ${pid} must exit before the measured reopen.`);
    await delay(100);
  }
}

async function identifyEnginePid(mainPid) {
  const processRows = (await run("ps", ["-axo", "pid=,ppid=,comm="])).trim().split("\n").map(row => row.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean);
  const engines = processRows.filter(row => Number(row[2]) === mainPid && /(?:^|\/)bun$/.test(row[3]));
  assert.equal(engines.length, 1, "Identify the isolated local engine before measuring it.");
  return Number(engines[0][1]);
}

async function thumbnailFileStats() {
  const root = path.join(output, "profile", "design-storage");
  const rows = new Map();
  const walk = async directory => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile() && entry.name.endsWith(".png")) {
        const stat = await fs.stat(file);
        rows.set(file, { mtimeMs: stat.mtimeMs, bytes: stat.size });
      }
    }
  };
  await walk(root);
  return rows;
}

function changedThumbnailFiles(before, after) {
  return [...after.entries()].filter(([file, row]) => {
    const old = before.get(file);
    return !old || old.bytes !== row.bytes || Math.abs(old.mtimeMs - row.mtimeMs) > 1;
  }).map(([file]) => file);
}

let app, vite, viteLog, viteCache, page, enginePid;
async function close() {
  await app?.close().catch(() => {});
  app = undefined; page = undefined;
  vite?.kill("SIGTERM");
  vite = undefined;
  if (viteCache) await fs.rm(viteCache, { recursive: true, force: true }).catch(() => {});
  viteCache = undefined;
  await viteLog?.close().catch(() => {});
  viteLog = undefined;
}

async function bootNativeApp(stage, cdpPort, env, setupSettleMs = 3000) {
  app = await launchNativeElectron({ args: [stage, `--remote-debugging-port=${cdpPort}`, "--remote-debugging-address=127.0.0.1"], cwd: fixtures[0].folder, env, timeout: 90_000 });
  page = await app.firstWindow({ timeout: 60_000 });
  page.setDefaultTimeout(30_000);
  page.on("console", message => report.rendererConsole.push({ type: message.type(), text: message.text().slice(0, 500) }));
  page.on("requestfailed", request => report.rendererConsole.push({ type: "requestfailed", text: `${request.url()} ${request.failure()?.errorText ?? ""}`.slice(0, 500) }));
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.setBounds({ x: 0, y: 40, width: 1440, height: 1000 });
    win.setResizable(false); win.setMaximizable(false); win.setFullScreenable(false);
    win.setIgnoreMouseEvents(true);
    win.show();
  });
  await page.addInitScript(() => {
    if (globalThis.window !== globalThis.window.top) return;
    globalThis.localStorage.setItem("zeros.column2.ratio", "0.1");
  });
  await page.reload();
  await page.waitForFunction(() => globalThis.window.__ZEROS_NATIVE__?.localDevelopment === true);
  // A cold isolated Vite cache can reload once while dependencies optimize.
  // Let that settle before trusted driver imports; this is setup, not measured work.
  await delay(setupSettleMs);
  report.probe = { url: page.url(), module: await page.evaluate(async () => {
    const response = await fetch("/apps/desktop/src/renderer/platform/bridge/active-bridge.ts");
    return { status: response.status, type: response.headers.get("content-type"), text: (await response.text()).slice(0, 80) };
  }).catch(error => String(error?.message ?? error)) };
  await waitForNativeRenderer(page, async () => (await import("/apps/desktop/src/renderer/platform/bridge/active-bridge.ts")).getActiveBridge()?.status === "connected");
  const runtime = await app.evaluate(({ app }) => ({ electron: process.versions.electron, chromium: process.versions.chrome, mainPid: process.pid, userData: app.getPath("userData") }));
  runtime.enginePid = await identifyEnginePid(runtime.mainPid);
  enginePid = runtime.enginePid;
  return runtime;
}

const report = {
  recordedAt: new Date().toISOString(),
  platform: process.platform,
  architecture: process.arch,
  hardware: { cpus: os.availableParallelism(), cpuModel: os.cpus()[0]?.model, memoryBytes: os.totalmem() },
  counts,
  source,
  output,
  method: "Zeros Local development build in an isolated profile. Two pages per fixture; each page has the requested frame count. Every fourth replicated demo frame is replaced by an empty frame. Timings are milliseconds. CPU percent is cumulative process CPU seconds divided by wall time; it can exceed 100 across cores. Opening fits the page, so first complete paint means every frame in the active page has a ready native/vector surface or decoded picture. Page switching restores that page's camera, so its first complete paint means every currently mounted target-page frame is ready. Workspace switching is driven through the same workspace-store dispatch used by the app; page switching uses the visible page-picker click path.",
  limitations: [
    "Development Electron/Vite/engine build, not a packaged production build.",
    "CDP wheel input measures renderer presentation, not optical input-to-photon latency.",
    "CPU profiles are separate repeated gestures; idle and measured interaction CPU are collected with profiling stopped.",
    "RSS and physical footprint are sampled values, not transient peaks.",
  ],
  fixtures: [], measurements: [], pageSwitches: [], workspaceSwitches: [], interactions: [], profiles: [], failures: [], rendererConsole: [],
};
const save = () => writeNativeJson(path.join(output, "report.json"), report);
const fixtures = [];

try {
  console.log(`SCALE_STAGE fixtures ${output}`);
  for (const count of counts) {
    const fixture = await makeFixture(count);
    fixtures.push(fixture);
    report.fixtures.push({ id: fixture.id, count, empty: fixture.empty, rich: fixture.rich, pages: fixture.pages, bytes: fixture.frameBytes });
    await save();
  }

  console.log("SCALE_STAGE build");
  const stage = path.join(output, "app");
  await fs.mkdir(stage);
  for (const directory of ["node_modules", "apps", "packages", "resources", "styles"])
    await fs.symlink(path.join(repo, directory), path.join(stage, directory), "dir");
  await fs.copyFile(path.join(repo, "package.json"), path.join(stage, "package.json"));
  const identity = { slug: randomUUID().replace(/-/g, "").slice(0, 16), name: "Zeros Design Scale Baseline" };
  const ports = await pickLocalPorts(identity.slug);
  const cdpPort = await freePort();
  const env = {
    ...localEnvironment({ identity, ...ports }),
    ZEROS_ISOLATE: "1",
    ZEROS_NO_ENGINE_HMR: "1",
    ZEROS_NO_MAIN_HMR: "1",
    ZEROS_DATA_DIR: path.join(output, "profile"),
    ELECTRON_RENDERER_URL: `http://127.0.0.1:${ports.vitePort}`,
  };
  await fs.writeFile(path.join(output, "main-build.log"), await run("pnpm", ["exec", "tsup", "--config", "apps/desktop/electron/tsup.config.ts", "--out-dir", path.join(stage, "dist-electron"), "--metafile"], { cwd: repo, env, timeout: 300_000 }));
  const viteConfig = path.join(output, "vite.config.mjs");
  await fs.writeFile(viteConfig, nativeViteConfiguration(repo, viteCache = path.join(repo, "node_modules", `.vite-scale-${identity.slug}`)));
  viteLog = await fs.open(path.join(output, "vite.log"), "w");
  vite = spawn(process.execPath, [path.join(repo, "node_modules/vite/bin/vite.js"), "--config", viteConfig, "--host", "127.0.0.1", "--port", String(ports.vitePort), "--strictPort"], { cwd: repo, env, stdio: ["ignore", viteLog.fd, viteLog.fd] });
  const viteDeadline = Date.now() + 60_000;
  while (!(await fetch(env.ELECTRON_RENDERER_URL).then(response => response.ok, () => false))) {
    assert(Date.now() < viteDeadline, "Scale baseline Vite did not start.");
    await delay(100);
  }

  console.log("SCALE_STAGE launch");
  report.runtime = await bootNativeApp(stage, cdpPort, env);

  for (const fixture of fixtures) {
    fixture.workspace = await page.evaluate(async ({ folder, branchName, id }) => {
      const { upsertProject } = await import("/apps/desktop/src/renderer/state/projects-store.ts");
      const { notifyProjectsChanged } = await import("/apps/desktop/src/renderer/state/use-projects.ts");
      const { workspacePrepareCreate, workspaceCreate } = await import("/apps/desktop/src/renderer/platform/git.ts");
      const project = upsertProject({ repoRoot: folder, repoSlug: `design-scale-${id}`, isGitRepository: true });
      notifyProjectsChanged();
      const prepared = await workspacePrepareCreate({ repoRoot: folder, repoSlug: project.repoSlug });
      return workspaceCreate({ repoRoot: folder, repoSlug: project.repoSlug, organizationId: null, preparedId: prepared.workspaceId, preparedBranch: prepared.branch });
    }, fixture);
  }
  await save();

  const waitForCompletePaint = async (fixture, timeout = 60_000, started = performance.now(), expectedPageId) => {
    await waitForNativeRenderer(page, async ({ workspaceId, expected, expectedPageId }) => {
      if (expectedPageId) {
        const { useDesignWorkspaceUiStore } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-ui.ts");
        if (useDesignWorkspaceUiStore.getState().byWorkspace[workspaceId]?.activePageId !== expectedPageId) return false;
      }
      const owner = globalThis.document.querySelector(`[data-design-retained-workspace="${workspaceId}"][aria-hidden="false"]`);
      const covered = [...(owner?.querySelectorAll("[data-design-frame]") ?? [])].filter(frame =>
        frame.querySelector('iframe[data-design-document-buffer="displayed"][data-design-document-ready],[data-design-source-buffer="displayed"][data-design-source-ready]') ||
        [...frame.querySelectorAll("img[data-design-frame-picture],img[data-design-frame-screenshot],img[data-design-frame-transition-cover]")].some(image =>
          image.complete && image.naturalWidth > 0 && globalThis.getComputedStyle(image).display !== "none" && globalThis.getComputedStyle(image).visibility === "visible")
      ).length;
      return covered >= expected;
    }, { workspaceId: fixture.workspace.workspaceId, expected: fixture.count, expectedPageId }, timeout);
    return performance.now() - started;
  };
  const waitForVisiblePaint = async (fixture, targetPage, timeout = 60_000, started = performance.now()) => {
    await waitForNativeRenderer(page, async ({ workspaceId, pageId, files }) => {
      const { useDesignWorkspaceUiStore } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-ui.ts");
      if (useDesignWorkspaceUiStore.getState().byWorkspace[workspaceId]?.activePageId !== pageId) return false;
      const owner = globalThis.document.querySelector(`[data-design-retained-workspace="${workspaceId}"][aria-hidden="false"]`);
      const wanted = new Set(files);
      const frames = [...(owner?.querySelectorAll("[data-design-frame]") ?? [])]
        .filter(frame => wanted.has(frame.getAttribute("data-design-frame")));
      if (!frames.length) return false;
      return frames.every(frame =>
        frame.querySelector('iframe[data-design-document-buffer="displayed"][data-design-document-ready],[data-design-source-buffer="displayed"][data-design-source-ready]') ||
        [...frame.querySelectorAll("img[data-design-frame-picture],img[data-design-frame-screenshot],img[data-design-frame-transition-cover]")].some(image =>
          image.complete && image.naturalWidth > 0 && globalThis.getComputedStyle(image).display !== "none" && globalThis.getComputedStyle(image).visibility === "visible"));
    }, { workspaceId: fixture.workspace.workspaceId, pageId: targetPage.id, files: targetPage.files }, timeout);
    return performance.now() - started;
  };
  const memoryRows = () => sampleNativeApplicationMemory({ app, enginePid });
  const sampleMemory = async seconds => {
    const before = await memoryRows();
    assert(before.some(row => row.role === "GPU" && row.rssBytes !== null && row.physicalFootprintBytes !== null), "GPU memory evidence is required.");
    const started = performance.now();
    await delay(seconds * 1000);
    const elapsed = (performance.now() - started) / 1000;
    const after = await memoryRows();
    return summarizeMemory(after, before, elapsed);
  };
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const rendererMetrics = async () => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map(({ name, value }) => [name, value]));

  let viewportRect;
  const open = async fixture => {
    const started = performance.now();
    await runNativeRendererAction(page, async ({ workspacePath, repoRoot }) => {
      const { useWorkspaceStore } = await import("/apps/desktop/src/renderer/state/workspace-store.ts");
      useWorkspaceStore.getState().dispatch({ type: "OPEN_WORKSPACE", folder: workspacePath, repoRoot, chatId: null });
    }, { workspacePath: fixture.workspace.path, repoRoot: fixture.folder });
    await activateNativeWorkbenchTab(page, fixture.workspace.path, "design");
    const owner = page.locator(`[data-design-retained-workspace="${fixture.workspace.workspaceId}"][aria-hidden="false"]`);
    await owner.locator("[data-design-canvas-viewport]").waitFor();
    viewportRect ??= await owner.locator("[data-design-canvas-viewport]").boundingBox();
    const camera = {
      zoom: Math.max(0.01, Math.min(0.25, (viewportRect.width - 64) / fixture.bounds.width, (viewportRect.height - 64) / fixture.bounds.height)),
      panX: 32,
      panY: 96,
    };
    await prepareNativeDesignView(page, fixture.workspace.workspaceId, camera);
    const completeMs = await waitForCompletePaint(fixture);
    const actionToCompleteMs = performance.now() - started;
    const completeAtMs = performance.now();
    await delay(2000);
    return { elapsedMs: performance.now() - started, actionToCompleteMs, completeMs, completeAtMs, camera };
  };

  for (const fixture of fixtures) {
    console.log(`SCALE_STAGE measure-${fixture.id}`);
    const opened = await open(fixture);
    const idleMemory = await sampleMemory(5);
    const beforeMetrics = await rendererMetrics();
    await delay(1000);
    const afterMetrics = await rendererMetrics();
    const dom = await page.evaluate(() => ({
      frames: globalThis.document.querySelector('[data-design-retained-workspace][aria-hidden="false"]')?.querySelectorAll("[data-design-frame]").length ?? 0,
      documents: globalThis.document.querySelectorAll("iframe[data-design-document-buffer],iframe[data-design-source-buffer]").length,
      nodes: globalThis.document.querySelectorAll("*").length,
    }));
    report.measurements.push({
      fixture: fixture.id,
      openElapsedMs: milliseconds(opened.elapsedMs),
      firstCompletePaintMs: milliseconds(opened.actionToCompleteMs),
      paintAfterCameraMs: milliseconds(opened.completeMs),
      idleMemory,
      rendererMetrics: {
        taskSecondsPerSecond: afterMetrics.TaskDuration - beforeMetrics.TaskDuration,
        scriptSecondsPerSecond: afterMetrics.ScriptDuration - beforeMetrics.ScriptDuration,
        jsHeapUsedMiB: megabytes(afterMetrics.JSHeapUsedSize),
        documents: afterMetrics.Documents,
        nodes: afterMetrics.Nodes,
      },
      dom,
      camera: opened.camera,
    });
    await page.screenshot({ path: path.join(output, `scale-${fixture.id}.png`) });
    await save();
  }

  async function traceGesture(fixture, name, { profile = false } = {}) {
    await open(fixture);
    await prepareNativeDesignView(page, fixture.workspace.workspaceId, { zoom: fixture.camera?.zoom ?? 0.05, panX: 32, panY: 96 });
    await delay(500);
    const events = [];
    const collect = data => events.push(...data.value);
    cdp.on("Tracing.dataCollected", collect);
    const complete = new Promise(resolve => cdp.once("Tracing.tracingComplete", resolve));
    const prefix = `zeros:design:scale:${name}:${fixture.id}`;
    const beforeMemory = await memoryRows();
    const memoryStarted = performance.now();
    await cdp.send("Tracing.start", { categories: "benchmark,input,blink.user_timing,disabled-by-default-devtools.timeline.frame", transferMode: "ReportEvents" });
    if (profile) {
      await cdp.send("Profiler.enable");
      await cdp.send("Profiler.setSamplingInterval", { interval: 1000 });
      await cdp.send("Profiler.start");
    }
    await startNativeDesignCameraObservation(page, prefix);
    const input = await dispatchNativeDesignGesture(cdp, {
      name,
      startZoom: fixture.camera?.zoom ?? 0.05,
      x: viewportRect.x + viewportRect.width / 2,
      y: viewportRect.y + viewportRect.height / 2,
      steps: 360,
      rateHz: 120,
    });
    const cameraChanges = await finishNativeDesignCameraObservation(page, prefix);
    const elapsedSeconds = (performance.now() - memoryStarted) / 1000;
    const afterMemory = await memoryRows();
    const cpuProfile = profile ? (await cdp.send("Profiler.stop")).profile : null;
    if (cpuProfile) await fs.writeFile(path.join(output, `${fixture.id}-${name}-cpu-profile.json`), JSON.stringify(cpuProfile));
    await delay(300);
    await cdp.send("Tracing.end");
    await complete;
    cdp.off("Tracing.dataCollected", collect);
    await fs.writeFile(path.join(output, `${fixture.id}-${name}${profile ? "-profiled" : ""}-trace.json`), JSON.stringify({ traceEvents: events }));
    const first = events.find(event => event.name === `${prefix}:start`);
    const last = events.find(event => event.name === `${prefix}:end`);
    assert(first && last && first.pid === last.pid, "Scale trace must include workload markers.");
    const presentation = analyzeDesignPresentationTrace(events, { rendererPid: first.pid, startUs: first.ts, endUs: last.ts });
    return {
      fixture: fixture.id,
      name,
      cameraChanges,
      input,
      memory: summarizeMemory(afterMemory, beforeMemory, elapsedSeconds),
      cpuProfileTop: summarizeCpuProfile(cpuProfile),
      ...presentation,
      effectiveFps: Math.round(presentation.presented / Math.max(1, input.durationMs / 1000) * 10) / 10,
    };
  }

  for (const fixture of fixtures) {
    fixture.camera = report.measurements.find(row => row.fixture === fixture.id)?.camera;
    for (const name of ["pan", "zoom"]) {
      console.log(`SCALE_STAGE trace-${fixture.id}-${name}`);
      report.interactions.push(await traceGesture(fixture, name));
      const profiled = await traceGesture(fixture, name, { profile: true });
      report.profiles.push({ fixture: fixture.id, name, cameraChanges: profiled.cameraChanges, input: profiled.input, top: profiled.cpuProfileTop });
      await save();
    }
  }

  const pageFixture = fixtures[0];
  console.log("SCALE_STAGE page-switch");
  await open(pageFixture);
  await runNativeRendererAction(page, async workspaceId => {
    const { useDesignWorkspaceUiStore } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-ui.ts");
    useDesignWorkspaceUiStore.getState().setPanels(workspaceId, { inspectorVisible: true, layersDrawerOpen: false });
  }, pageFixture.workspace.workspaceId);
  const pageButton = title => page.locator(`button[aria-label="Page: ${title}"]:visible`).first();
  await pageButton("Page 1").waitFor({ state: "visible" });
  for (const targetIndex of [1, 0]) {
    const target = pageFixture.pages[targetIndex];
    const current = pageFixture.pages[targetIndex ? 0 : 1];
    await pageButton(current.title).click();
    const started = performance.now();
    await page.getByRole("menuitemradio", { name: target.title }).click();
    const completeMs = await waitForVisiblePaint(pageFixture, target, 60_000, started);
    report.pageSwitches.push({ fixture: pageFixture.id, from: current.title, to: target.title, clickToFirstCompletePaintMs: milliseconds(completeMs), wallMs: milliseconds(performance.now() - started) });
    await save();
  }

  await runNativeRendererAction(page, async workspaceId => {
    const { useDesignWorkspaceUiStore } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-ui.ts");
    useDesignWorkspaceUiStore.getState().setPanels(workspaceId, { inspectorVisible: false, layersDrawerOpen: false });
  }, pageFixture.workspace.workspaceId);

  console.log("SCALE_STAGE workspace-switch");
  const first = fixtures[0], second = fixtures[Math.min(1, fixtures.length - 1)];
  if (second !== first) {
    await open(first);
    await open(second);
    for (const fixture of [first, second, first, second]) {
      const started = performance.now();
      try {
        const opened = await open(fixture);
        report.workspaceSwitches.push({ fixture: fixture.id, actionToFirstCompletePaintMs: milliseconds(opened.actionToCompleteMs), settledWallMs: milliseconds(performance.now() - started) });
      } catch (error) {
        report.workspaceSwitches.push({ fixture: fixture.id, failed: true, error: String(error?.message ?? error).slice(0, 300), settledWallMs: milliseconds(performance.now() - started) });
      }
      await save();
    }
  }

  if (reopen) {
    const target = fixtures.find(fixture => fixture.count === 1000) ?? fixtures[fixtures.length - 1];
    console.log(`SCALE_STAGE reopen-${target.id}`);
    const usage = async () => page.evaluate(async () => (await import("/apps/desktop/src/renderer/features/design-workspace/state/use-design-frame-previews.ts")).designSourcePreviewUsage());
    const indexedDbCount = async () => page.evaluate(async () => new Promise(resolve => {
      const request = indexedDB.open("zeros:design-previews:v1");
      request.onerror = () => resolve(null);
      request.onsuccess = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("pictures")) { db.close(); resolve(null); return; }
        const count = db.transaction("pictures", "readonly").objectStore("pictures").count();
        count.onsuccess = () => { db.close(); resolve(count.result); };
        count.onerror = () => { db.close(); resolve(null); };
      };
    }));
    const completedPictures = async fixture => page.evaluate(({ workspaceId }) => {
      const owner = globalThis.document.querySelector(`[data-design-retained-workspace="${workspaceId}"][aria-hidden="false"]`);
      return [...(owner?.querySelectorAll("img[data-design-frame-picture],img[data-design-frame-screenshot],img[data-design-frame-transition-cover]") ?? [])]
        .filter(image => image.complete && image.naturalWidth > 0 && globalThis.getComputedStyle(image).display !== "none" && globalThis.getComputedStyle(image).visibility === "visible").length;
    }, { workspaceId: fixture.workspace.workspaceId });
    const coldUsage = await usage();
    const beforeIndexedDb = await indexedDbCount();
    const beforeThumbnails = await thumbnailFileStats();
    const coldPictures = await completedPictures(target);
    const launchStarted = performance.now();
    // Renderer reload keeps the engine alive while dropping renderer memory,
    // object URLs and decoded pictures; persistent preview stores remain visible.
    await page.reload();
    await page.waitForFunction(() => globalThis.window.__ZEROS_NATIVE__?.localDevelopment === true);
    await waitForNativeRenderer(page, async () => (await import("/apps/desktop/src/renderer/platform/bridge/active-bridge.ts")).getActiveBridge()?.status === "connected");
    const runtime = report.runtime;
    // Adopted fixture workspaces are runtime registrations rather than durable
    // project rows in this isolated harness; restore the same registration as
    // setup before timing the warm open itself.
    const adoptStarted = performance.now();
    await page.evaluate(async ({ folder, id }) => {
      const { upsertProject } = await import("/apps/desktop/src/renderer/state/projects-store.ts");
      const { notifyProjectsChanged, notifyWorkspacesChanged } = await import("/apps/desktop/src/renderer/state/use-projects.ts");
      const project = upsertProject({ repoRoot: folder, repoSlug: `design-scale-${id}`, isGitRepository: true });
      notifyProjectsChanged();
      notifyWorkspacesChanged(project.repoSlug);
    }, target);
    const listArgs = () => ({ repoSlug: target.workspace.repoSlug ?? `design-scale-${target.id}`, workspaceId: target.workspace.workspaceId ?? target.workspace.id });
    const workspaceListed = async () => page.evaluate(async ({ repoSlug, workspaceId }) => {
      try {
        const { workspaceListSnapshot, workspaceGet } = await import("/apps/desktop/src/renderer/platform/git.ts");
        const rows = (await workspaceListSnapshot({ repoSlug, archived: false, includeDesign: true })).workspaces;
        const all = (await workspaceListSnapshot({ archived: false, includeDesign: true })).workspaces;
        const unfiltered = (await workspaceListSnapshot({ includeDesign: true })).workspaces;
        let got = null, getError = null;
        try { got = await workspaceGet(workspaceId); } catch (error) { getError = String(error?.message ?? error); }
        return { ok: rows.some(workspace => workspace.id === workspaceId), rows: rows.map(workspace => ({ id: workspace.id, repoSlug: workspace.repoSlug })), all: all.map(workspace => ({ id: workspace.id, repoSlug: workspace.repoSlug })), unfiltered: unfiltered.map(workspace => ({ id: workspace.id, repoSlug: workspace.repoSlug, archivedAt: workspace.archivedAt })), got, getError };
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) };
      }
    }, listArgs());
    const workspaceListing = await workspaceListed();
    const adoptMs = performance.now() - adoptStarted;
    const reopenCdp = await page.context().newCDPSession(page);
    await reopenCdp.send("Profiler.enable");
    await reopenCdp.send("Profiler.setSamplingInterval", { interval: 1000 });
    await reopenCdp.send("Profiler.start");
    const reopenStartUsage = await usage();
    const opened = await open(target);
    const profile = (await reopenCdp.send("Profiler.stop")).profile;
    await fs.writeFile(path.join(output, "reopen-cpu-profile.json"), JSON.stringify(profile));
    const completeAt = opened.completeAtMs;
    const afterUsage = await usage();
    const afterIndexedDb = await indexedDbCount();
    const afterThumbnails = await thumbnailFileStats();
    const rewritten = changedThumbnailFiles(beforeThumbnails, afterThumbnails);
    const delta = key => Math.max(0, (afterUsage[key] ?? 0) - (reopenStartUsage[key] ?? 0));
    const produced = delta("batched") + delta("vector") + delta("native");
    const paintedPictures = await completedPictures(target);
    report.reopen = {
      fixture: target.id,
      launchToFirstCompletePaintMs: milliseconds(completeAt - launchStarted),
      openActionToFirstCompletePaintMs: milliseconds(opened.actionToCompleteMs),
      paintAfterCameraMs: milliseconds(opened.completeMs),
      coldCompletedPictures: coldPictures,
      warmCompletedPictures: paintedPictures,
      coldProductionTotals: coldUsage,
      reopenStartProductionTotals: reopenStartUsage,
      indexedDbRecordsBefore: beforeIndexedDb,
      indexedDbRecordsAfter: afterIndexedDb,
      engineThumbnailFilesBefore: beforeThumbnails.size,
      engineThumbnailFilesAfter: afterThumbnails.size,
      productionDelta: { batched: delta("batched"), vector: delta("vector"), native: delta("native"), fallbacks: delta("fallbacks") },
      estimates: {
        indexedDbPictures: Math.max(0, paintedPictures - produced),
        engineStorePictures: Math.max(0, delta("batched") - rewritten.length),
        freshEngineRenders: rewritten.length,
        freshVectorOrNativeRenders: delta("vector") + delta("native"),
      },
      rewrittenEngineThumbnailFiles: rewritten.length,
      workspaceListing,
      adoptSetupMs: milliseconds(adoptMs),
      runtime,
      cpuProfileTop: summarizeCpuProfile(profile),
    };

    // Close the Design surface within the same renderer/workspace, then reopen it.
    // This distinguishes in-memory retention from renderer-reload persistent-store hits.
    await activateNativeWorkbenchTab(page, target.workspace.path, "changes");
    await delay(500);
    const tabStartUsage = await usage();
    const tabBeforeThumbnails = await thumbnailFileStats();
    const tabStarted = performance.now();
    await activateNativeWorkbenchTab(page, target.workspace.path, "design");
    const tabCompleteMs = await waitForCompletePaint(target, 60_000, tabStarted);
    const tabAfterUsage = await usage();
    const tabAfterThumbnails = await thumbnailFileStats();
    const tabRewritten = changedThumbnailFiles(tabBeforeThumbnails, tabAfterThumbnails);
    const tabDelta = key => Math.max(0, (tabAfterUsage[key] ?? 0) - (tabStartUsage[key] ?? 0));
    const tabProduced = tabDelta("batched") + tabDelta("vector") + tabDelta("native");
    const tabPainted = await completedPictures(target);
    report.workspaceCloseReopen = {
      fixture: target.id,
      actionToFirstCompletePaintMs: milliseconds(tabCompleteMs),
      paintedPictures: tabPainted,
      productionDelta: { batched: tabDelta("batched"), vector: tabDelta("vector"), native: tabDelta("native"), fallbacks: tabDelta("fallbacks") },
      rewrittenEngineThumbnailFiles: tabRewritten.length,
      estimates: {
        memoryOrIndexedDbPictures: Math.max(0, tabPainted - tabProduced),
        freshEngineRenders: tabRewritten.length,
      },
    };
    await save();
  }

  const width = rows => rows.map(row => `| ${row.join(" | ")} |`).join("\n");
  const measurementRows = report.measurements.map(row => [
    row.fixture,
    row.openElapsedMs,
    row.firstCompletePaintMs,
    row.idleMemory.renderer.rssMiB,
    row.idleMemory.renderer.physicalMiB,
    row.idleMemory.renderer.cpuPercent.toFixed(1),
    row.idleMemory.gpu.rssMiB,
    row.idleMemory.gpu.physicalMiB,
    row.idleMemory.gpu.cpuPercent.toFixed(1),
    row.idleMemory.engine.rssMiB,
    row.idleMemory.engine.cpuPercent.toFixed(1),
    row.dom.frames,
    row.dom.documents,
  ]);
  const interactionRows = report.interactions.map(row => [
    row.fixture,
    row.name,
    row.presented,
    row.effectiveFps,
    row.frameIntervalMs?.p95?.toFixed(2),
    row.frameIntervalMs?.p99?.toFixed(2),
    row.inputToPresentMs?.p95?.toFixed(2),
    row.dropped,
    row.partial,
    row.cameraChanges,
    row.memory.renderer.cpuPercent.toFixed(1),
    row.memory.gpu.cpuPercent.toFixed(1),
    row.memory.engine.cpuPercent.toFixed(1),
  ]);
  const reopenMarkdown = report.reopen ? `## Warm reopen

| Fixture | Launch to first complete paint ms | Open action to paint ms | Painted pictures | IndexedDB pictures est. | Engine-store pictures est. | Fresh engine renders est. | Fresh vector/native renders | IndexedDB records before/after | Engine thumbnails before/after |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
${width([[report.reopen.fixture, report.reopen.launchToFirstCompletePaintMs, report.reopen.openActionToFirstCompletePaintMs, report.reopen.warmCompletedPictures, report.reopen.estimates.indexedDbPictures, report.reopen.estimates.engineStorePictures, report.reopen.estimates.freshEngineRenders, report.reopen.estimates.freshVectorOrNativeRenders, `${report.reopen.indexedDbRecordsBefore}/${report.reopen.indexedDbRecordsAfter}`, `${report.reopen.engineThumbnailFilesBefore}/${report.reopen.engineThumbnailFilesAfter}`]])}

Top reopen CPU self-time: ${report.reopen.cpuProfileTop.slice(0, 5).map(frame => `${frame.frame} (${frame.estimatedSelfMs} ms)`).join("; ") || "none"}

` : "";
  const markdown = `# Zeros Design scale baseline\n\nRecorded: ${report.recordedAt}\n\n## Scale fixtures\n\n| Frames/page | Empty | Rich demo-derived | Open ms | First complete paint ms | Renderer RSS MiB | Renderer footprint MiB | Renderer CPU % | GPU RSS MiB | GPU footprint MiB | GPU CPU % | Engine RSS MiB | Engine CPU % | Mounted frames | Documents |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n${width(report.measurements.map(row => [row.fixture, report.fixtures.find(f => f.id === row.fixture)?.empty, report.fixtures.find(f => f.id === row.fixture)?.rich, ...measurementRows.find(m => m[0] === row.fixture).slice(1)]))}\n\n## Pan/zoom presentation\n\n| Frames/page | Gesture | Presented | Effective FPS | Frame p95 ms | Frame p99 ms | Input-present p95 ms | Dropped | Partial | Camera changes | Renderer CPU % | GPU CPU % | Engine CPU % |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n${width(interactionRows)}\n\n## CPU profiled repeated gestures (top self-time frames)\n\n| Frames/page | Gesture | Frame | Samples | Estimated self ms |\n|---|---:|---|---:|---:|\n${width(report.profiles.flatMap(row => (row.top ?? []).slice(0, 5).map(frame => [row.fixture, row.name, frame.frame, frame.samples, frame.estimatedSelfMs])))}\n\n## Page switching\n\n| Fixture | From | To | Click to first complete paint ms | Wall ms |\n|---|---|---|---:|---:|\n${width(report.pageSwitches.map(row => [row.fixture, row.from, row.to, row.clickToFirstCompletePaintMs, row.wallMs]))}\n\n## Workspace switching\n\n| Fixture | Switch to first complete paint ms | Settled wall ms |\n|---|---:|---:|\n${width(report.workspaceSwitches.map(row => [row.fixture, row.actionToFirstCompletePaintMs, row.settledWallMs]))}\n\n${reopenMarkdown}## Method and caveats\n\n${report.method}\n\n${report.limitations.map(line => `- ${line}`).join("\n")}\n`;
  await fs.writeFile(path.join(output, "report.md"), `${markdown}\n`);
  console.log(`SCALE_REPORT ${path.join(output, "report.md")}`);
} catch (error) {
  report.failures.push(error.stack ?? String(error));
  process.exitCode = 1;
  if (page) await page.screenshot({ path: path.join(output, "failure.png") }).catch(() => {});
} finally {
  try { save(); }
  catch { /* Preserve the original measurement failure. */ }
  if (!keepApp) await close();
}
