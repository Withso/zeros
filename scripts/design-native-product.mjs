// Native qualification product stage, launched only by design-native-run.mjs.
// Runs production main/preload/engine with disposable Personal Local fixtures.
// It never opens or changes a user's project, profile, branch or build output.
import assert from "node:assert/strict";
import { nativeDesignHiddenResourcesRetired } from "./design-native-view.mjs";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { launchNativeElectron } from "./design-native-electron.mjs";
import { nativeViteConfiguration } from "./design-native-vite.mjs";
import { localEnvironment, pickLocalPorts } from "./electron-local.mjs";
import { runNativeDesignBaseline } from "./design-native-baseline.mjs";

import { activateNativeWorkbenchTab } from "./design-native-workbench.mjs";
import { waitForNativeRenderer } from "./design-native-renderer.mjs";
import { selectNativeDesignFrame } from "./design-native-view.mjs";
import { collectNativeSourceManifest, writeNativeJson } from "./design-native-run.mjs";

const exec = promisify(execFile);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidence = path.resolve(process.argv[2] ?? ".");
const allowed = path.join(repo, ".context", "design-native");
if (path.dirname(evidence) !== allowed || !/^[a-zA-Z0-9-]+$/.test(path.basename(evidence)))
  throw new Error("Use scripts/design-native-run.mjs to launch the product stage.");
const lock = JSON.parse(await fs.readFile(path.join(allowed, "run.lock"), "utf8"));
if (lock.pid !== process.ppid || lock.runId !== path.basename(evidence))
  throw new Error("The product stage requires its owning qualification launcher.");
if (process.platform !== "darwin") throw new Error("Native product qualification requires macOS.");
const report = { startedAt: new Date().toISOString(), platform: process.platform,
  architecture: process.arch, checks: [], samples: [], failures: [],
  limitations: ["Development build with source engine and Vite; not a packaged release or a before/after performance comparison.",
    "Personal Local fixtures only. Existing organization-owned Local behavior is covered by the separate automated owner/race suites, not this native run.",
    "No OS energy, input-to-present latency or minimum-memory hardware qualification."] };
const reportFile = path.join(evidence, "product-report.json");
const status = async stage => {
  writeNativeJson(path.join(evidence, "product-status.json"), { pid: process.pid, stage, at: new Date().toISOString() });
  console.log(`PRODUCT_STAGE ${stage}`);
};
const save = async () => writeNativeJson(reportFile, report);
const check = (label, value) => { assert(value, label); report.checks.push(label); console.log(`PASS ${label}`); };
const run = async (command, args, options = {}) => (await exec(command, args, { cwd: repo, timeout: 120_000, maxBuffer: 4 * 1024 * 1024, ...options })).stdout;
const manifest = () => collectNativeSourceManifest(repo);
async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
const root = await fs.mkdtemp(path.join(evidence, "product-"));
const stage = path.join(root, "app");
await fs.mkdir(stage);
report.artifacts = path.relative(repo, root);
let app;
let vite;
let viteLog;
let page;
const deadline = setTimeout(() => { console.error("Native product qualification deadline exceeded"); void app?.close().finally(() => process.exit(124)); if (!app) process.exit(124); }, 15 * 60_000);
try {
  await status("preparing");
  report.sourceDigest = manifest().digest;
  report.revision = (await run("git", ["rev-parse", "HEAD"])).trim();
  const identity = { slug: `design-qual-${randomUUID().slice(0, 8)}`, name: "Zeros Design Qualification" };
  const ports = await pickLocalPorts(identity.slug);
  const cdpPort = await freePort();
  const env = { ...localEnvironment({ identity, ...ports }), ZEROS_ISOLATE: "1", ZEROS_NO_ENGINE_HMR: "1", ZEROS_NO_MAIN_HMR: "1", ZEROS_DATA_DIR: path.join(root, "profile"), ELECTRON_RENDERER_URL: `http://127.0.0.1:${ports.vitePort}` };
  const fixtures = [];
  for (const count of [2, 32, 128, 256]) {
    const folder = path.join(root, `fixture-${count}`);
    const output = await run("bun", ["scripts/design-performance-fixture.ts", "--frames", String(count), "--output", folder, ...(count === 32 ? ["--complex"] : [])], { env });
    const branchName = (await run("git", ["-C", folder, "symbolic-ref", "--short", "HEAD"])).trim();
    fixtures.push({ count, folder, branchName, fixture: JSON.parse(output.slice(output.indexOf("{"))) });
  }
  for (const directory of ["node_modules", "apps", "packages", "resources", "styles"]) {
    try { await fs.access(path.join(repo, directory)); await fs.symlink(path.join(repo, directory), path.join(stage, directory), "dir"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  await fs.copyFile(path.join(repo, "package.json"), path.join(stage, "package.json"));
  await status("compiling-production-main");
  const buildLog = await run("pnpm", ["exec", "tsup", "--config", "apps/desktop/electron/tsup.config.ts", "--out-dir", path.join(stage, "dist-electron"), "--metafile"], { env });
  await fs.writeFile(path.join(root, "main-build.log"), buildLog);
  // The production dev launcher resolves the source engine through apps/.
  // Refuse stale-binary fallback so this report always tests current sources.
  await run("bun", ["--version"], { env });
  const viteConfig = path.join(root, "vite.config.mjs");
  await fs.writeFile(viteConfig, nativeViteConfiguration(repo, path.join(root, "vite-cache")));
  viteLog = await fs.open(path.join(root, "vite.log"), "w");
  vite = spawn(process.execPath, [path.join(repo, "node_modules/vite/bin/vite.js"), "--config", viteConfig, "--host", "127.0.0.1", "--port", String(ports.vitePort), "--strictPort"], { cwd: repo, env, stdio: ["ignore", viteLog.fd, viteLog.fd] });
  const readyBy = Date.now() + 60_000;
  while (!(await fetch(env.ELECTRON_RENDERER_URL).then(r => r.ok, () => false))) {
    assert(Date.now() < readyBy, "Qualification Vite server did not start");
    await delay(100);
  }
  await status("starting-production-app");
  app = await launchNativeElectron({ args: [stage, `--remote-debugging-port=${cdpPort}`, "--remote-debugging-address=127.0.0.1"], cwd: fixtures[0].folder, env, timeout: 90_000 });
  page = await app.firstWindow({ timeout: 60_000 });
  page.setDefaultTimeout(30_000);
  await page.waitForFunction(() => globalThis.window.__ZEROS_NATIVE__?.localDevelopment === true);
  await waitForNativeRenderer(page, async () => (await import("/apps/desktop/src/renderer/platform/bridge/active-bridge.ts")).getActiveBridge()?.status === "connected");
  report.runtime = await app.evaluate(({ app }) => ({ electron: process.versions.electron, chromium: process.versions.chrome, mainPid: process.pid, userData: app.getPath("userData") }));
  check("The production native app uses the isolated qualification profile", report.runtime.userData === env.ZEROS_DATA_DIR);
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setBounds({ x: 50, y: 50, width: 1440, height: 1000 }); window.show(); });
  for (const fixture of fixtures) {
    fixture.workspace = await page.evaluate(async ({ folder, branchName, count }) => {
      const { upsertProject } = await import("/apps/desktop/src/renderer/state/projects-store.ts");
      const { notifyProjectsChanged, notifyWorkspacesChanged } = await import("/apps/desktop/src/renderer/state/use-projects.ts");
      const { workspaceAdoptExisting } = await import("/apps/desktop/src/renderer/platform/git.ts");
      const project = upsertProject({ repoRoot: folder, repoSlug: `design-native-${count}`, isGitRepository: true });
      notifyProjectsChanged();
      const workspace = await workspaceAdoptExisting({ repoRoot: folder, worktreePath: folder, branchName, repoSlug: project.repoSlug, organizationId: null });
      notifyWorkspacesChanged(project.repoSlug);
      const { useDesignWorkspaceUiStore } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-ui.ts");
      useDesignWorkspaceUiStore.getState().setViewport(workspace.workspaceId, { zoom: 0.8, panX: 80, panY: 80 });
      return workspace;
    }, fixture);
  }
  const open = async fixture => {
    await page.evaluate(async folder => {
      const { useWorkspaceStore } = await import("/apps/desktop/src/renderer/state/workspace-store.ts");
      useWorkspaceStore.getState().dispatch({ type: "OPEN_WORKSPACE", folder, repoRoot: folder, chatId: null });
    }, fixture.folder);
    await activateNativeWorkbenchTab(page, fixture.folder, "design");
    await page.locator('[data-design-retained-workspace="' + fixture.workspace.workspaceId + '"][aria-hidden="false"] [data-design-canvas-viewport]').waitFor();
    await page.locator('[data-design-retained-workspace="' + fixture.workspace.workspaceId + '"] iframe:is([data-design-document-ready],[data-design-source-ready]):visible').first().waitFor();
  };
  const resources = () => page.evaluate(async () => (await import("/apps/desktop/src/renderer/features/design-workspace/state/design-renderer-resources.ts")).designRendererResources());
  const activate = (fixture, tab) => activateNativeWorkbenchTab(page, fixture.folder, tab);
  const processRows = (await run("ps", ["-axo", "pid=,ppid=,comm="])).trim().split("\n").map(row => row.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean);
  const engineRows = processRows.filter(row => Number(row[2]) === report.runtime.mainPid && /(?:^|\/)bun$/.test(row[3]));
  const enginePid = engineRows.length === 1 ? Number(engineRows[0][1]) : undefined;
  report.runtime.enginePid = enginePid ?? null;
  const nativeMetrics = async () => ({
    recordedAt: new Date().toISOString(),
    processes: await app.evaluate(({ app }) => app.getAppMetrics().map(({ pid, type, cpu, memory }) => ({
      pid, role: type, cpuSeconds: cpu.cumulativeCPUUsage,
      rssBytes: memory.workingSetSize * 1024,
      lifetimePeakRssBytes: memory.peakWorkingSetSize * 1024,
    }))),
  });
  report.memoryAccounting = "Per-process RSS samples; never summed as private memory. Lifetime peak RSS is not attributed to an individual capture. The 100 ms capture sampler reports observed samples, not an upper bound on transient memory.";
  for (const fixture of fixtures) {
    await status(`fixed-view-${fixture.count}`);
    const began = performance.now();
    await open(fixture);
    check(`${fixture.count} frames open through the authenticated native protocol`, await page.locator('[data-design-retained-workspace="' + fixture.workspace.workspaceId + '"] iframe[src^="zeros-design:"]').count() > 0);
    const sample = { frames: fixture.count, readyMs: performance.now() - began, resources: await resources(), native: await nativeMetrics() };
    report.samples.push(sample);
    const screenshot = path.join(root, `native-${fixture.count}.png`);
    await page.screenshot({ path: screenshot });
    await runNativeDesignBaseline({ endpoint: `http://127.0.0.1:${cdpPort}`, output: path.join(root, `baseline-${fixture.count}.json`), scenario: `fixed-view-${fixture.count}`, enginePid });
    await save();
  }
  await status("capture-and-shared-admission");
  const fixture = fixtures[0];
  await open(fixture);
  await selectNativeDesignFrame(page, fixture.workspace.workspaceId);
  await waitForNativeRenderer(page, async () => {
    const state = (await import("/apps/desktop/src/renderer/features/design-workspace/state/design-renderer-resources.ts")).designRendererResources();
    return state.captures.running === 0 && state.captures.queued === 0 && state.counters.tileRequests.current === 0;
  });
  const captureSamples = [];
  let sampleCapture = true;
  let captureSamplingError;
  const sampling = (async () => {
    while (sampleCapture) {
      captureSamples.push(await nativeMetrics());
      await delay(100);
    }
  })().catch(error => { captureSamplingError = error; sampleCapture = false; });
  let captured;
  try {
    captured = await page.evaluate(async (workspaceId) => {
    const { designFrameRuntime } = await import("/apps/desktop/src/renderer/platform/bridge/design-frame-runtime.ts");
    const frame = globalThis.document.querySelector('[data-design-retained-workspace="' + workspaceId + '"] [data-design-frame] iframe[data-design-document-ready]')?.closest("[data-design-frame]")?.getAttribute("data-design-frame");
    const runtime = designFrameRuntime(workspaceId, frame);
    if (!runtime) throw new Error("A ready native frame has no runtime connection");
    const id = globalThis.crypto.randomUUID();
    const admission = await globalThis.window.__ZEROS_NATIVE__.invoke("design_capture_acquire", { jobId: id, explicit: true });
    if (!admission.acquired) throw new Error("The capture host did not become idle");
    let optionalDenied = false;
    let released;
    try { await runtime.captureScreenshot(null, 1, undefined, "nearby"); }
    catch (error) { optionalDenied = /capacity/.test(error.message); }
    finally { released = await globalThis.window.__ZEROS_NATIVE__.invoke("design_capture_release", { jobId: id }); }
    if (!released.released) throw new Error("Reservation cleanup was not acknowledged");
    const png = await runtime.captureScreenshot(null, 1);
    return { optionalDenied, width: png.width, height: png.height, bytes: png.dataUrl.length, sourceVersion: png.sourceVersion };
    }, fixture.workspace.workspaceId);
  } finally {
    sampleCapture = false;
    await sampling;
    report.captureProcessSamples = captureSamples;
    if (captureSamplingError) {
      report.captureSamplingError = captureSamplingError.message;
    }
  }
  if (captureSamplingError) throw captureSamplingError;
  check("A native reservation prevents an optional in-frame capture", captured.optionalDenied);
  check("Explicit native in-frame capture succeeds after acknowledged release", captured.width > 0 && captured.height > 0 && captured.bytes > 100);
  report.capture = captured;
  await status("workspace-switching");
  for (let index = 0; index < 20; index++) {
    // Capture ended in fixtures[0]; the first visit must actually switch away.
    const target = fixtures[(index + 1) % 2];
    await open(target);
    const owner = await page.locator('[data-design-retained-workspace][aria-hidden="false"]').getAttribute("data-design-retained-workspace");
    check(`Workspace switch ${index + 1} displays the exact requested owner`, owner === target.workspace.workspaceId);
    report.samples.push({ switch: index + 1, workspace: target.workspace.workspaceId, resources: await resources(), native: await nativeMetrics() });
    await save();
  }
  check("Twenty Personal Local workspace switches preserve usable native documents", true);
  await open(fixture);
  await activate(fixture, "files");
  await status("hidden-retirement");
  await page.waitForFunction(() => globalThis.document.querySelectorAll('[data-design-retained-workspace] iframe[data-design-document-buffer]').length === 0, undefined, { timeout: 35_000 });
  const hidden = await resources();
  report.hidden = hidden;
  check("Hidden native Design documents retire after the production grace period with bounded warm caches", nativeDesignHiddenResourcesRetired(hidden));
  const hiddenBefore = await app.evaluate(({ app }) => app.getAppMetrics().map(({ type, pid, cpu, memory }) => ({ type, pid, cpu, memory })));
  const idleStarted = performance.now();
  await delay(60_000);
  report.hiddenIdle = { seconds: (performance.now() - idleStarted) / 1000, before: hiddenBefore, after: await app.evaluate(({ app }) => app.getAppMetrics().map(({ type, pid, cpu, memory }) => ({ type, pid, cpu, memory }))) };
  await open(fixture);
  check("Returning after native retirement prepares a usable current document", true);
  check("Qualification inputs remained unchanged during the run", manifest().digest === report.sourceDigest);
} catch (error) {
  report.failures.push(error.stack ?? String(error));
  if (page) {
    await page.screenshot({ path: path.join(root, "failure.png") }).catch(() => {});
    report.visibleFixtureText = await page.locator("body").innerText().then(value => value.slice(0, 4000), () => "unavailable");
  }
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  await app?.close().catch(error => { report.failures.push(`App close: ${error.message}`); process.exitCode = 1; });
  if (vite?.pid) { try { vite.kill("SIGTERM"); } catch (error) { if (error.code !== "ESRCH") report.failures.push(`Vite close: ${error.message}`); } }
  await viteLog?.close();
  report.finishedAt = new Date().toISOString();
  await save();
  await status(report.failures.length ? "failed" : "complete");
  console.log(JSON.stringify({ checks: report.checks.length, failures: report.failures, report: path.relative(repo, reportFile) }));
}
