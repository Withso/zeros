#!/usr/bin/env node
// Production renderer + compiled engine, isolated Local compatibility fixtures.
// A repeatable performance workload; no account/profile/source from the operator
// is copied. Status survives transport loss. A failed run stays failed evidence.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { localEnvironment, pickLocalPorts } from "./electron-local.mjs";
import { ensureDevAuthEnvironment } from "./dev-auth-profile.mjs";
import { acquireNativeRunLock, collectNativeSourceManifest, nativeProcessAlive, readNativeReportJson, writeNativeJson } from "./design-native-run.mjs";
import { launchNativeElectron } from "./design-native-electron.mjs";
import { selectNativeOwner, waitForNativeOwnerAccess } from "./design-native-owner-access.mjs";
import { buildNativeProduction, serveNativeProductionAssets } from "./design-native-production.mjs";
import { withNativeRendererModules, waitForNativeRenderer, nativePageSession } from "./design-native-renderer.mjs";
import { activateNativeWorkbenchTab, prepareNativeWorkspaceCatalog } from "./design-native-workbench.mjs";
import { prepareNativeDesignView, selectNativeDesignFrame,
  startNativeDesignCameraObservation, finishNativeDesignCameraObservation, readNativeDesignCoverage } from "./design-native-view.mjs";
import { dispatchMacDesignGesture } from "./design-native-input.mjs";
import { sampleNativeApplicationMemory, sampleNativeMemoryPlateau, startNativeMemoryGuard, nativeApplicationProcessIdentities, observeNativeApplicationProcesses, waitForNativeProcessRetirement } from "./design-native-memory.mjs";
import { measureNativeIdleCpu } from "./design-native-cpu.mjs";
import { assertNativeMemoryBudget } from "./design-native-baseline.mjs";
import { analyzeDesignPresentationTrace, assessDesignPerformance } from "./design-performance-budget.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.join(repo, ".context/design-performance-native");
const exec = promisify(execFile);
const viewportSelector = '[data-design-retained-workspace][aria-hidden="false"] [data-design-canvas-viewport]';

async function latest() {
  try {
    const marker = readNativeReportJson(path.join(root, "latest.json"));
    assert(/^[0-9T-]+-[a-f0-9]{8}$/.test(marker.runId), "Invalid performance run identity.");
    return readNativeReportJson(path.join(root, marker.runId, "report.json"));
  } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function authoredManifest(fixtures) {
  const rows = [];
  async function visit(directory, workspace) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if ([".git", ".zeros", "node_modules"].includes(entry.name)) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file, workspace);
      else if (entry.isFile()) rows.push({ fixture: workspace.fixture, file: path.relative(workspace.path, file),
        sha256: createHash("sha256").update(await fs.readFile(file)).digest("hex") });
      else throw new Error("Authored fixture must contain ordinary files.");
    }
  }
  for (const workspace of fixtures) await visit(workspace.path, workspace);
  return rows.sort((a, b) => `${a.fixture}/${a.file}`.localeCompare(`${b.fixture}/${b.file}`));
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log("pnpm design:performance:native [--source-digest SHA256]\npnpm design:performance:native --status"); return;
  }
  if (args.length === 1 && args[0] === "--status") {
    const previous = await latest();
    const retirement = previous?.retirement?.processes?.length
      ? await waitForNativeProcessRetirement(previous.retirement.processes, { timeoutMs: 0 }) : null;
    console.log(JSON.stringify(previous ? { runId: previous.runId, stage: previous.stage, pid: previous.pid,
      alive: nativeProcessAlive(previous.pid), mainAlive: nativeProcessAlive(previous.runtime?.mainPid),
      cycles: previous.memory?.cycles?.length, finishedAt: previous.finishedAt, error: previous.error, acceptance: previous.acceptance,
      retirement: retirement ? { retired: retirement.retired, remaining: retirement.remaining, unknown: retirement.unknown } : undefined,
      evidence: path.join(root, previous.runId) } : { stage: "not-started" }, null, 2)); return;
  }
  assert(args.length === 0 || (args.length === 2 && args[0] === "--source-digest" && /^[a-f0-9]{64}$/.test(args[1])), "Use --help for performance arguments.");
  assert.equal(process.platform, "darwin", "Native performance acceptance requires macOS.");
  const previous = await latest();
  if (previous) {
    assert.equal(nativeProcessAlive(previous.pid), false, "An earlier benchmark driver remains; recover --status before another launch.");
    if (previous.retirement?.processes?.length) {
      const retired = await waitForNativeProcessRetirement(previous.retirement.processes, {
        requiredPids: [previous.runtime?.mainPid, previous.runtime?.enginePid].filter(Number.isSafeInteger), timeoutMs: 0,
      });
      assert(retired.retired, "An earlier benchmark helper remains; recover --status before another launch.");
    } else for (const pid of [previous.runtime?.mainPid, previous.runtime?.enginePid]) {
      if (Number.isSafeInteger(pid)) assert.equal(nativeProcessAlive(pid), false, "An earlier benchmark process remains; recover --status before another launch.");
    }
  }
  const sources = collectNativeSourceManifest(repo);
  if (args.length) assert.equal(sources.digest, args[1], "Wait for verified source sync before launching.");
  const runId = `${new Date().toISOString().replace(/[^0-9T]/g, "")}-${randomUUID().slice(0, 8)}`;
  const release = acquireNativeRunLock(root, runId), evidence = path.join(root, runId);
  await fs.mkdir(evidence, { mode: 0o700 });
  const report = { runId, pid: process.pid, platform: process.platform, startedAt: new Date().toISOString(),
    stage: "preparing", build: { mode: "production", hmr: false, sourceDigest: sources.digest },
    hardware: { arch: process.arch, os: os.release(), memoryBytes: os.totalmem(), cpu: os.cpus()[0]?.model },
    interactions: [], idle: [], idleObservations: [], openings: [], scenarios: [], checks: [], memory: { warm: [], cycles: [], settled: [], peakAppBytes: 0, peakGpuBytes: 0 },
    limitations: ["Optimized renderer and compiled engine in an unpackaged, isolated Local host; release signing/updater are outside this workload.",
      "Organization Local rows are disposable compatibility fixtures under confirmed normal Dev membership; no new organization or cloud workspace is created.",
      "Opening/source-update readiness and resize wall time include driver observations; they are not first-pixel or input-to-presentation percentiles. Presentation targets apply to continuous pan/zoom traces.",
      "Chromium presentation timestamps are not optical display latency. Physical memory is sampled, not an OS quota; short peaks can be missed."] };
  const save = stage => { if (stage) report.stage = stage; writeNativeJson(path.join(evidence, "report.json"), report); };
  const phase = stage => { save(stage); console.log(`DESIGN_PERFORMANCE ${stage}`); };
  save(); writeNativeJson(path.join(root, "latest.json"), { runId }); writeNativeJson(path.join(evidence, "sources.json"), sources);
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error("Native performance run cancelled."));
  // Ten settled-memory blocks and bounded invalid idle-window replacements
  // need time in addition to the 100 navigation cycles. Keep a finite owner.
  const deadline = setTimeout(() => controller.abort(new Error("Native performance deadline exceeded.")), 35 * 60_000);
  process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
  const pause = ms => delay(ms, undefined, { signal: controller.signal });
  const run = async (command, argv, options = {}) => (await exec(command, argv, { cwd: repo, timeout: 180_000,
    maxBuffer: 16 * 1024 ** 2, signal: controller.signal, ...options })).stdout;
  let app, server, page, rawPage, cdp, guard, enginePid, fixtures, authoredBefore;
  const restores = [];
  const memorySamples = [];
  try {
    const identity = { slug: `design-accept-${runId.slice(-8)}`, name: "Zeros Performance Qualification" };
    const ports = await pickLocalPorts(identity.slug);
    const env = localEnvironment({ identity, ...ports });
    // Ordinary Dev reads its normal shared sign-in; only workspace data and
    // browser state are isolated. Local-development mode pins Personal, and a
    // ZEROS_DATA_DIR override would redirect the shared sign-in store too.
    for (const name of ["ZEROS_LOCAL_DEVELOPMENT", "ZEROS_ISOLATE", "ZEROS_DATA_DIR", "ZEROS_SHARED_SECRETS_DIR"]) delete env[name];
    const auth = await ensureDevAuthEnvironment({ processEnv: {} });
    assert.equal(auth.issue, null, "A validated public Alpha Dev configuration is required.");
    Object.assign(env, auth.env, { NODE_ENV: "production", ZEROS_NO_MAIN_HMR: "1", ZEROS_NO_ENGINE_HMR: "1" });
    const profile = path.join(os.homedir(), "Library/Application Support", `com.zeros.dev.${identity.slug}`);
    await fs.mkdir(profile, { mode: 0o700 });
    writeNativeJson(path.join(profile, "design-qualification-owner.json"), { runId });
    report.profile = profile;
    phase("production-build");
    const built = await buildNativeProduction({ repo, root: evidence, env, run });
    report.build.diskFreeBytes = built.diskFreeBytes;
    server = await serveNativeProductionAssets(built.output, ports.vitePort);
    env.ELECTRON_RENDERER_URL = server.url;
    const launch = async cwd => {
      app = await launchNativeElectron({ args: [built.stage], cwd, env, timeout: 90_000 });
      report.runtime = { mainPid: app.process().pid }; save();
      await observeNativeApplicationProcesses(app);
      rawPage = await app.firstWindow({ timeout: 60_000 }); rawPage.setDefaultTimeout(30_000);
      await rawPage.addInitScript(() => localStorage.setItem("zeros.column2.ratio", "0.1"));
      await rawPage.reload({ waitUntil: "domcontentloaded" });
      page = await withNativeRendererModules(rawPage, { moduleUrl: `${server.url}/${built.modulePath}` });
      const membership = await waitForNativeOwnerAccess(page, 60_000);
      assert.equal(membership.blocked, null, membership.blocked ?? "Normal Dev authorization failed.");
      assert.equal(await app.evaluate(({ app }) => app.getPath("userData")), profile);
      const rows = (await run("ps", ["-axo", "pid=,ppid=,comm="])).split("\n").map(row => row.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean);
      const engines = rows.filter(row => Number(row[2]) === report.runtime.mainPid && row[3].startsWith(path.join(built.stage, "binaries/zeros-engine-")));
      assert.equal(engines.length, 1, "The benchmark must measure its compiled engine, not a source engine.");
      enginePid = Number(engines[0][1]); report.runtime.enginePid = enginePid; save();
      return membership;
    };
    phase("normal-owner-authorization");
    const membership = await launch(evidence);
    report.authorization = { signedIn: membership.signedIn, confirmedOrganization: true, method: "Normal Dev sign-in and authenticated /v1/me" };
    report.authorizationRuntime = report.runtime;
    await sampleNativeApplicationMemory({ app, enginePid });
    const authorizationProcesses = nativeApplicationProcessIdentities(app);
    await app.close();
    report.authorizationRuntime.retirement = await waitForNativeProcessRetirement(authorizationProcesses, {
      requiredPids: [report.runtime.mainPid, enginePid],
    });
    assert(report.authorizationRuntime.retirement.retired, "Authorization host and helpers must retire before seeding its own database.");
    report.authorizationRuntime.retired = true; enginePid = undefined;
    phase("fixtures");
    const compatibility = path.join(evidence, "compatibility");
    await run("bun", ["scripts/design-owner-compatibility-fixture.ts", "--output", compatibility, "--organization-id", membership.organizationId]);
    const owners = JSON.parse(await fs.readFile(path.join(compatibility, "fixture.json"), "utf8"));
    assert.equal(JSON.parse(await fs.readFile(path.join(profile, "design-qualification-owner.json"), "utf8")).runId, runId);
    for (const name of ["zeros.db", "zeros.db-wal", "zeros.db-shm"]) {
      await fs.rename(path.join(profile, name), path.join(profile, `${name}.auth-probe`)).catch(error => { if (error.code !== "ENOENT") throw error; });
    }
    await fs.copyFile(path.join(owners.profile, "zeros.db"), path.join(profile, "zeros.db"));
    fixtures = owners.workspaces.map(w => ({ ...w, fixture: w.fixtureOwner, count: 2 }));
    for (const spec of [{ fixture: "2", count: 2 }, { fixture: "32", count: 32 }, { fixture: "128", count: 128 },
      { fixture: "256", count: 256 }, { fixture: "complex-32", count: 32, complex: true }, { fixture: "mixed-2", count: 2, mixed: true },
      { fixture: "overview-256", count: 256 }]) {
      const folder = path.join(evidence, `fixture-${spec.fixture}`);
      const output = await run("bun", ["scripts/design-performance-fixture.ts", "--frames", String(spec.count), "--layout", "grid", "--output", folder,
        ...(spec.complex ? ["--complex"] : []), ...(spec.mixed ? ["--mixed"] : [])]);
      const generated = JSON.parse(output.slice(output.indexOf("{")));
      fixtures.push({ ...spec, path: folder, repoRoot: folder, repoSlug: `perf-${spec.fixture}`, organizationId: null,
        branchName: (await run("git", ["-C", folder, "symbolic-ref", "--short", "HEAD"])).trim(), designDirectory: generated.designDirectory });
    }
    authoredBefore = await authoredManifest(fixtures);
    writeNativeJson(path.join(evidence, "authored-before.json"), authoredBefore);
    phase("native-launch");
    assert.equal((await launch(fixtures[0].path)).organizationId, membership.organizationId, "Membership changed during fixture setup.");
    const buildMode = await rawPage.evaluate(url => import(url).then(bundle => bundle.build), `${server.url}/${built.modulePath}`);
    assert(buildMode.mode === "production" && buildMode.development === false, "The app renderer must be optimized production code.");
    report.runtime = await app.evaluate(({ app, BrowserWindow, screen }) => {
      const window = BrowserWindow.getAllWindows()[0];
      const area = screen.getDisplayMatching(window.getBounds()).workArea;
      // Keep the measured canvas on the actual display, including laptops
      // whose usable height is smaller than the reference window.
      window.setBounds({ x: area.x, y: area.y, width: Math.min(1440, area.width), height: Math.min(1000, area.height) });
      window.setIgnoreMouseEvents(true); window.show(); window.focus();
      const display = screen.getDisplayMatching(window.getBounds());
      return { mainPid: process.pid, windowId: window.id, electron: process.versions.electron, chromium: process.versions.chrome,
        display: { frequencyHz: display.displayFrequency, scaleFactor: display.scaleFactor, size: display.size },
        userData: app.getPath("userData"), mockKeychain: app.commandLine.hasSwitch("use-mock-keychain"),
        backgroundTimersDisabled: app.commandLine.hasSwitch("disable-background-timer-throttling") };
    });
    report.runtime.enginePid = enginePid;
    report.runtime.localDevelopment = await page.evaluate(() => globalThis.window.__ZEROS_NATIVE__?.localDevelopment);
    assert.equal(report.runtime.userData, profile);
    assert(!report.runtime.mockKeychain && !report.runtime.backgroundTimersDisabled, "Use normal native scheduling and Keychain behavior.");
    save();
    const sample = () => sampleNativeApplicationMemory({ app, enginePid });
    const totals = processes => ({ appBytes: processes.reduce((n, p) => n + p.physicalFootprintBytes, 0),
      gpuBytes: processes.filter(p => p.role.toLowerCase() === "gpu").reduce((n, p) => n + p.physicalFootprintBytes, 0) });
    const recordSample = async () => {
      const processes = await sample();
      assertNativeMemoryBudget(processes, { maxTotalBytes: 3072 * 1024 ** 2, maxGpuBytes: 1536 * 1024 ** 2 });
      const total = totals(processes);
      memorySamples.push({ at: new Date().toISOString(), phase: report.stage, ...total, processes });
      report.memory.peakAppBytes = Math.max(report.memory.peakAppBytes, total.appBytes);
      report.memory.peakGpuBytes = Math.max(report.memory.peakGpuBytes, total.gpuBytes);
      writeNativeJson(path.join(evidence, "memory.json"), memorySamples); save();
      return { ...total, processes };
    };
    guard = await startNativeMemoryGuard({ sample, budget: { maxTotalBytes: 3072 * 1024 ** 2, maxGpuBytes: 1536 * 1024 ** 2 }, intervalMs: 2000,
      onSample: async record => {
        const total = totals(record.processes); memorySamples.push({ ...record, phase: report.stage, ...total });
        report.memory.peakAppBytes = Math.max(report.memory.peakAppBytes, total.appBytes); report.memory.peakGpuBytes = Math.max(report.memory.peakGpuBytes, total.gpuBytes);
        writeNativeJson(path.join(evidence, "memory.json"), memorySamples); save();
      }, onFailure: async error => { report.error = error.stack; save("memory-guard-failed"); controller.abort(error); await app.close(); } });
    cdp = await nativePageSession(rawPage);
    const resources = () => page.evaluate(async () => (await import("/apps/desktop/src/renderer/features/design-workspace/state/design-renderer-resources.ts")).designRendererResources());
    const residency = async () => ({ resources: await resources(),
      heap: await cdp.send("Runtime.getHeapUsage"), dom: await cdp.send("Memory.getDOMCounters") });
    for (const fixture of fixtures) {
      const id = await page.evaluate(async fixture => {
        const { upsertProject } = await import("/apps/desktop/src/renderer/state/projects-store.ts");
        const { notifyProjectsChanged, notifyWorkspacesChanged } = await import("/apps/desktop/src/renderer/state/use-projects.ts");
        const { workspaceAdoptExisting } = await import("/apps/desktop/src/renderer/platform/git.ts");
        const project = upsertProject({ repoRoot: fixture.path, repoSlug: fixture.repoSlug, isGitRepository: true });
        notifyProjectsChanged();
        const id = fixture.id ?? (await workspaceAdoptExisting({ repoRoot: fixture.path, worktreePath: fixture.path,
          branchName: fixture.branchName, repoSlug: project.repoSlug, organizationId: null })).workspaceId;
        notifyWorkspacesChanged(project.repoSlug); return id;
      }, fixture);
      fixture.id = id;
    }
    writeNativeJson(path.join(evidence, "workspaces.json"), fixtures);
    await prepareNativeWorkspaceCatalog(page, fixtures.map(fixture => ({ folder: fixture.path, workspaceId: fixture.id })));
    const cameras = new Map();
    const coverage = () => readNativeDesignCoverage(page);
    const ready = async fixture => {
      const until = Date.now() + 60000;
      for (;;) { guard.assertHealthy(); const c = await coverage(); if (c.id === fixture.id && c.covered === fixture.count) return;
        assert(Date.now() < until, `Incomplete ${fixture.fixture} coverage: ${JSON.stringify(c)}`); await pause(50); }
    };
    const open = async fixture => {
      const begin = performance.now();
      await selectNativeOwner(page, fixture);
      await page.evaluate(async fixture => { const { useWorkspaceStore } = await import("/apps/desktop/src/renderer/state/workspace-store.ts");
        useWorkspaceStore.getState().dispatch({ type: "OPEN_WORKSPACE", folder: fixture.path, repoRoot: fixture.repoRoot, chatId: null }); }, fixture);
      await activateNativeWorkbenchTab(page, fixture.path, "design");
      await prepareNativeDesignView(page, fixture.id, cameras.get(fixture.id) ?? { zoom: .075, panX: 32, panY: 96 });
      if (!cameras.has(fixture.id)) {
        const camera = await page.evaluate(async id => {
          const { designWorkspaceSnapshotCache } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-cache.ts");
          const snapshot = designWorkspaceSnapshotCache.peekSnapshot(id).data, frames = snapshot.preparation?.descriptions ?? snapshot.frames;
          const box = document.querySelector('[data-design-retained-workspace][aria-hidden="false"] [data-design-canvas-viewport]').getBoundingClientRect();
          const left = Math.min(...frames.map(f => f.x)), top = Math.min(...frames.map(f => f.y));
          return { zoom: Math.min(.7, (box.width - 64) / (Math.max(...frames.map(f => f.x + f.width)) - left), (box.height - 160) / (Math.max(...frames.map(f => f.y + f.height)) - top)), panX: 32, panY: 96 };
        }, fixture.id);
        cameras.set(fixture.id, camera); await prepareNativeDesignView(page, fixture.id, camera);
      }
      await ready(fixture); return performance.now() - begin;
    };
    phase("cold-and-warm-opening");
    for (const fixture of fixtures) report.openings.push({ fixture: fixture.fixture, coldReadyMs: await open(fixture) });
    for (const fixture of fixtures) report.openings.find(row => row.fixture === fixture.fixture).warmReadyMs = await open(fixture);
    const overview = fixtures.find(f => f.fixture === "overview-256"), organization = fixtures.find(f => f.fixture === "organization-local");
    await open(overview);
    report.runtime.viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio }));
    phase("presentation");
    await app.evaluate(({ app, BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.setIgnoreMouseEvents(false); window.show(); window.focus(); app.focus({ steal: true });
    });
    for (let repeat = 1; repeat <= 3; repeat++) for (const name of ["pan", "zoom"]) {
      const startCamera = cameras.get(overview.id);
      await prepareNativeDesignView(page, overview.id, startCamera); await pause(1000);
      const box = await page.locator(viewportSelector).boundingBox(), events = [];
      const collect = data => events.push(...data.value); cdp.on("Tracing.dataCollected", collect);
      const complete = new Promise(resolve => cdp.once("Tracing.tracingComplete", resolve));
      const prefix = `zeros:design:${name}:${repeat}`;
      assert.equal(await page.evaluate(() => document.visibilityState), "visible", "The benchmark window must remain visible.");
      const bounds = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentBounds());
      await cdp.send("Tracing.start", { categories: "benchmark,input,blink.user_timing,disabled-by-default-devtools.timeline.frame", transferMode: "ReportEvents" });
      await startNativeDesignCameraObservation(page, prefix);
      // One real native gesture keeps began/changed/ended phases continuous.
      // Individual CDP wheel commands synthesize an end for every command and
      // change Chromium's acknowledgement/scheduling path. Retain that older
      // evidence with its original driver; do not attribute this to rendering.
      const inputWorkload = await dispatchMacDesignGesture({
        pid: report.runtime.mainPid, name, startZoom: startCamera.zoom,
        x: bounds.x + box.x + box.width / 2, y: bounds.y + box.y + box.height / 2,
      }, { signal: controller.signal });
      const cameraChanges = await finishNativeDesignCameraObservation(page, prefix);
      await pause(300); await cdp.send("Tracing.end"); await complete; cdp.off("Tracing.dataCollected", collect);
      await fs.writeFile(path.join(evidence, `${name}-${repeat}-trace.json`), JSON.stringify({ traceEvents: events }));
      const first = events.find(e => e.name === prefix + ":start"), last = events.find(e => e.name === prefix + ":end");
      assert(first && last && first.pid === last.pid, "The native trace must contain this app's workload markers.");
      report.interactions.push({ name, repeat, cameraChanges, inputWorkload,
        ...analyzeDesignPresentationTrace(events, { rendererPid: first.pid, startUs: first.ts, endUs: last.ts }),
        // Observe allocation categories after tracing/input stop; JS heap and
        // DOM counts are diagnostics, never substitutes for physical memory.
        rendererMemory: { heap: await cdp.send("Runtime.getHeapUsage"), dom: await cdp.send("Memory.getDOMCounters") },
      });
      save(); guard.assertHealthy();
    }
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setIgnoreMouseEvents(true));
    phase("editing-resize-capture");
    const small = fixtures.find(f => f.fixture === "2"); await open(small);
    const selected = await selectNativeDesignFrame(page, small.id);
    const frame = page.locator(`[data-design-retained-workspace="${small.id}"] [data-design-frame=${JSON.stringify(selected)}]`);
    const handle = frame.locator('[data-design-resize-edge="s"]').first(); await handle.waitFor();
    const point = await handle.boundingBox(), originalSize = await frame.boundingBox(), resizeStarted = performance.now();
    await page.mouse.move(point.x + point.width / 2, point.y + point.height / 2); await page.mouse.down();
    for (let i = 1; i <= 20; i++) await page.mouse.move(point.x + point.width / 2, point.y + point.height / 2 + i * 3);
    const changedSize = await frame.boundingBox();
    assert(Math.abs(originalSize.height - changedSize.height) > 4, "The resize gesture must actually change frame geometry.");
    await page.keyboard.press("Escape"); await page.mouse.up();
    const restoredSize = await frame.boundingBox();
    assert(Math.abs(originalSize.width - restoredSize.width) < 1 && Math.abs(originalSize.height - restoredSize.height) < 1, "Resize cancellation must restore frame geometry.");
    report.scenarios.push({ name: "frame-resize-cancel", observedDurationMs: performance.now() - resizeStarted });
    const editAndRestore = async (fixture, file, revision) => {
      const sourceFile = path.join(fixture.path, fixture.designDirectory, file), original = await fs.readFile(sourceFile);
      const restored = () => fs.writeFile(sourceFile, original); restores.push(restored);
      const image = page.locator(`[data-design-retained-workspace="${fixture.id}"] [data-design-frame=${JSON.stringify(file)}] [data-design-source-vector][data-design-source-ready][data-design-source-buffer="displayed"]`).first();
      const originalVersion = await image.getAttribute("data-design-source-version"), begin = performance.now();
      assert(originalVersion, "Source edit needs a confirmed generation.");
      const changed = original.toString().replace("</head>", `<style>/* qualification ${revision} */ body { outline: 3px solid #276ef1; outline-offset: -3px }</style></head>`);
      assert.notEqual(changed, original.toString(), "Source edit must change the authored fixture.");
      await fs.writeFile(sourceFile, changed);
      const currentVersion = async () => image.evaluate(surface => { const img = surface.designSourceImage ?? surface; return img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0 ? img.dataset.designSourceVersion : null; });
      const until = Date.now() + 30000;
      for (;;) { const version = await currentVersion(); if (version && version !== originalVersion) break;
        assert(Date.now() < until, "Changed source was not displayed."); await pause(50); }
      const observedReadyMs = performance.now() - begin;
      await restored();
      const restoreUntil = Date.now() + 30000;
      while (await currentVersion() !== originalVersion) {
        assert(Date.now() < restoreUntil, "Restored source generation was not displayed."); await pause(50);
      }
      restores.pop(); return { observedReadyMs, restored: true };
    };
    report.scenarios.push({ name: "external-source-edit", ...await editAndRestore(small, selected, "editing") });
    const captured = await page.evaluate(async ({ workspaceId, frame }) => {
      const { getActiveBridge } = await import("/apps/desktop/src/renderer/platform/bridge/active-bridge.ts");
      const { bridgeDesignFrame, bridgeDesignPreview } = await import("/apps/desktop/src/renderer/platform/bridge/design-bridge.ts");
      const { useDesignWorkspaceUiStore } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-ui.ts");
      const bridge = getActiveBridge(), document = await bridgeDesignFrame(bridge, workspaceId, frame);
      const result = await bridgeDesignPreview(bridge, workspaceId, { directoryId: useDesignWorkspaceUiStore.getState().byWorkspace[workspaceId].directoryId,
        frame, sourceVersion: document.sourceVersion, theme: null, maxDimension: 560 }, { priority: "explicit" });
      const encoded = result.data ?? "";
      const bytes = encoded.length / 4 * 3 - (encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0);
      return { width: result.width, height: result.height, stale: result.stale, bytes };
    }, { workspaceId: small.id, frame: selected });
    assert(!captured.stale && captured.width > 0); report.scenarios.push({ name: "native-capture", ...captured });
    await open(overview); await cdp.send("Memory.simulatePressureNotification", { level: "critical" }); await ready(overview);
    report.pressureCovered = (await coverage()).covered;
    report.checks.push("cache pressure preserves all 256 frame coverage");
    phase("warm-plateau");
    // Warm the exact owner/hide/return workload before fixing its baseline.
    const cycle = async index => {
      await open(organization);
      assert((await coverage()).id === organization.id);
      await open(overview); await activateNativeWorkbenchTab(page, overview.path, "files");
      await waitForNativeRenderer(page, async () => {
        const r = (await import("/apps/desktop/src/renderer/features/design-workspace/state/design-renderer-resources.ts")).designRendererResources();
        return r.sourceLoads.active === 0 && r.sourceLoads.waiting === 0 && r.sourceVectorCache.leases === 0;
      });
      await activateNativeWorkbenchTab(page, overview.path, "design"); await ready(overview);
      const exercised = { appHidden: false, sourceChanged: false, pressure: false };
      if (index % 10 === 0) {
        const file = await page.locator(`[data-design-retained-workspace="${overview.id}"] [data-design-frame]`).first().getAttribute("data-design-frame");
        await editAndRestore(overview, file, `${report.stage}-${index}`); exercised.sourceChanged = true;
        await cdp.send("Memory.simulatePressureNotification", { level: "critical" }); await ready(overview); exercised.pressure = true;
        await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).hide(), report.runtime.windowId);
        await waitForNativeRenderer(page, () => document.visibilityState === "hidden");
        await pause(11000);
        const hidden = await resources();
        assert.equal(hidden.sourceLoads.active + hidden.sourceLoads.waiting + hidden.sourceVectorCache.leases, 0, "An app-hidden Design still owns optional source work.");
        await app.evaluate(({ BrowserWindow }, id) => { const window = BrowserWindow.fromId(id); window.show(); window.focus(); }, report.runtime.windowId);
        await waitForNativeRenderer(page, () => document.visibilityState === "visible"); await ready(overview); exercised.appHidden = true;
      }
      return exercised;
    };
    for (let i = 1; i <= 10; i++) await cycle(i);
    report.memory.warm = (await sampleNativeMemoryPlateau({ throughCycle: 0, sample: recordSample, pause })).samples;
    // These explicit reads do not trigger GC. Keep allocation categories with
    // each physical plateau so a growth failure can be attributed afterwards.
    report.memory.warmResidency = await residency();
    phase("100-owner-and-suspend-cycles");
    for (let i = 1; i <= 100; i++) {
      const exercised = await cycle(i);
      const sample = await recordSample();
      report.memory.cycles.push({ cycle: i, returned: true, ownerRoundTrip: true, suspended: true, ...exercised,
        appBytes: sample.appBytes, gpuBytes: sample.gpuBytes }); save();
      if (i % 10 === 0) {
        report.memory.settled.push({ ...await sampleNativeMemoryPlateau({ throughCycle: i, sample: recordSample, pause }),
          residency: await residency() });
        save();
      }
    }
    phase("idle-cpu");
    const idleWindow = async (hidden, repeat) => {
      await activateNativeWorkbenchTab(page, overview.path, hidden ? "files" : "design");
      if (!hidden) await ready(overview);
      await page.mouse.move(0, 0); await pause(11000);
      assert.equal(await page.evaluate(() => document.visibilityState), "visible", "Idle evidence requires a visible app window.");
      await page.evaluate(() => {
        globalThis.__designIdleVisibilityChanges = 0;
        globalThis.__designIdleVisibilityListener = () => { globalThis.__designIdleVisibilityChanges++; };
        document.addEventListener("visibilitychange", globalThis.__designIdleVisibilityListener);
      });
      const observation = await measureNativeIdleCpu({ sample, pause,
        sampleHistory: () => memorySamples.map(entry => entry.processes),
        onObservation: result => { report.idleObservations.push({ repeat, hidden, ...result }); save(); },
      });
      const changes = await page.evaluate(() => {
        document.removeEventListener("visibilitychange", globalThis.__designIdleVisibilityListener);
        return globalThis.__designIdleVisibilityChanges;
      });
      assert.equal(changes, 0, "The benchmark app changed visibility during idle measurement.");
      assert.equal(await page.evaluate(() => document.visibilityState), "visible", "The app was hidden during idle measurement.");
      const r = await resources();
      const hiddenJobs = r.captures.running + r.captures.queued + r.captures.cancelling + r.documents.active + r.documents.warm + r.documents.protected +
        r.sourceLoads.active + r.sourceLoads.waiting + r.preparation.running + r.previews.producing + r.previewDecodes.pending + r.previewDecodes.users;
      return { ...observation, hiddenJobs, resources: r };
    };
    for (let repeat = 1; repeat <= 3; repeat++) {
      const hidden = await idleWindow(true, repeat), visible = await idleWindow(false, repeat);
      report.idle.push({ repeat, seconds: Math.min(hidden.seconds, visible.seconds), visibleCpu: visible.percent, hiddenCpu: hidden.percent,
        hiddenJobs: hidden.hiddenJobs, hidden, visible }); save(); guard.assertHealthy();
    }
    report.sourcePreserved = JSON.stringify(await authoredManifest(fixtures)) === JSON.stringify(authoredBefore);
    report.build.finalSourceDigest = collectNativeSourceManifest(repo).digest;
    save("retiring-native-app");
  } catch (error) {
    // A guard failure aborts the current wait. Keep its original cause instead
    // of replacing the useful physical/process evidence with AbortError.
    report.error ??= (controller.signal.aborted ? controller.signal.reason : error)?.stack ?? String(error);
    save("failed"); console.error(report.error); process.exitCode = 1;
  } finally {
    for (const restore of restores) await restore().catch(error => { report.cleanupError = error.message; process.exitCode = 1; });
    await guard?.stop().catch(error => { report.error ??= error.stack; process.exitCode = 1; });
    if (app) await observeNativeApplicationProcesses(app).catch(error => { report.cleanupError ??= error.message; process.exitCode = 1; });
    const ownedProcesses = app ? nativeApplicationProcessIdentities(app) : [];
    await cdp?.detach().catch(() => {});
    await app?.close().catch(error => { report.cleanupError = error.message; process.exitCode = 1; });
    await server?.close().catch(error => { report.cleanupError = error.message; process.exitCode = 1; });
    try {
      report.retirement = await waitForNativeProcessRetirement(ownedProcesses, {
        requiredPids: [report.runtime?.mainPid, report.runtime?.enginePid].filter(Number.isSafeInteger),
      });
      report.runtimeRetired = !report.cleanupError && report.retirement.retired;
      if (!report.runtimeRetired) report.cleanupError ??= "An owned native app, engine or helper did not retire.";
    } catch (error) { report.runtimeRetired = false; report.cleanupError ??= error.message; }
    clearTimeout(deadline); process.off("SIGINT", cancel); process.off("SIGTERM", cancel);
    report.acceptance = assessDesignPerformance(report);
    report.stage = report.error || report.cleanupError ? "failed" : report.acceptance.passed ? "passed" : "failed-budgets";
    report.finishedAt = report.closedAt = new Date().toISOString(); save(); release();
    console.log(JSON.stringify({ evidence, acceptance: report.acceptance }, null, 2));
    if (!report.acceptance.passed) process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  void main().catch(error => { console.error(error.message); process.exitCode = 1; });
