// Controlled native workloads, owned by design-native-run.mjs. The reference
// checkout is read-only; builds, profiles, source fixtures and traces are isolated.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
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
import { collectNativeSourceManifest, writeNativeJson } from "./design-native-run.mjs";
import { runNativeRendererAction, waitForNativeRenderer } from "./design-native-renderer.mjs";
import { activateNativeWorkbenchTab, prepareNativeWorkspaceCatalog } from "./design-native-workbench.mjs";
import { runNativeDesignBaseline } from "./design-native-baseline.mjs";
import { sampleNativeApplicationMemory, startNativeMemoryGuard } from "./design-native-memory.mjs";
import { nativeViteConfiguration } from "./design-native-vite.mjs";
import { prepareNativeDesignView, readNativeDesignView, assertNativeDesignView, selectNativeDesignFrame, nativeDesignHiddenResourcesRetired } from "./design-native-view.mjs";

const exec = promisify(execFile);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidence = path.resolve(process.argv[2] ?? ".");
assert.equal(path.dirname(evidence), path.join(repo, ".context", "design-native"));
const lock = JSON.parse(await fs.readFile(path.join(path.dirname(evidence), "run.lock"), "utf8"));
assert(lock.pid === process.ppid && lock.runId === path.basename(evidence), "Use the owning native qualification runner.");
assert.equal(process.platform, "darwin", "This workload requires macOS.");
const reference = process.argv[3] && path.resolve(process.argv[3]);
if (reference) assert(reference.startsWith(path.join(repo, ".context") + path.sep), "Use a disposable reference checkout under .context.");
const root = await fs.mkdtemp(path.join(evidence, "performance-"));
// Keep this development workload below 3 GiB on a 16 GiB host. These sampled
// shutdown limits are separate from authored-source/cache admission estimates.
const memoryBudget = { maxGpuBytes: 1536 * 1024 ** 2, maxTotalBytes: 3072 * 1024 ** 2 };
const report = { platform: process.platform, startedAt: new Date().toISOString(),
  sourceDigest: collectNativeSourceManifest(repo).digest, artifacts: root, checks: [], failures: [], runs: [],
  hardware: { arch: process.arch, os: os.release(), memoryBytes: os.totalmem(), cpu: os.cpus()[0]?.model },
  memoryGuard: { ...memoryBudget, intervalMs: 1000, metric: "macOS physical footprint; RSS is reported separately", limitation: "Sampled shutdown guard, not an OS allocation quota. Sampling can miss transient peaks." },
  method: "Same authored fixtures, camera, panel state, window dimensions and dependencies. Two-second natural settle before snapshots and switches; no forced GC. Physical footprints are also sampled during loading and interaction. Each build has a fresh profile. Per-process RSS is never summed as private memory. Capture samples are observed values, not guaranteed transient peaks.",
  limitations: ["Development main/preload/renderer and source engine; not a packaged-release benchmark.",
    "Personal Local workloads; retained organization-owned Local requires separate qualification.",
    "Chromium traces require interpretation before any presented-frame or input-to-present claim. No OS energy or minimum-memory hardware qualification."] };
const save = () => writeNativeJson(path.join(evidence, "performance-report.json"), report);
const status = stage => { writeNativeJson(path.join(evidence, "performance-status.json"), { pid: process.pid, stage, at: new Date().toISOString() }); console.log(`PERFORMANCE_STAGE ${stage}`); save(); };
const check = (name, condition) => { assert(condition, name); report.checks.push(name); console.log(`PASS ${name}`); };
const run = async (command, args, options = {}) => (await exec(command, args, { cwd: repo, timeout: 120_000, maxBuffer: 8 * 1024 * 1024, ...options })).stdout;
async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function authoredManifest(folder) {
  const rows = [];
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if ([".git", ".zeros", "node_modules"].includes(entry.name)) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) rows.push({ file: path.relative(folder, file), sha256: createHash("sha256").update(await fs.readFile(file)).digest("hex") });
    }
  }
  await visit(folder);
  return rows.sort((a, b) => a.file.localeCompare(b.file));
}

let app, vite, viteLog, page, memoryGuard;
const deadline = setTimeout(() => { console.error("Native performance deadline exceeded"); void app?.close().finally(() => process.exit(124)); if (!app) process.exit(124); }, 16 * 60_000);
async function closeApp() {
  const guard = memoryGuard; memoryGuard = undefined;
  try { await guard?.stop(); }
  finally { await app?.close(); app = undefined; page = undefined; }
}
try {
  status("fixtures");
  const fixtures = [];
  const specs = [2, 32, 128, 256].map(count => ({ id: String(count), count, layout: "fixed-view" }));
  specs.push({ id: "complex-32", count: 32, layout: "fixed-view", complex: true },
    { id: "mixed-2", count: 2, layout: "fixed-view", mixed: true }, { id: "overview-256", count: 256, layout: "grid" });
  for (const spec of specs) {
    const folder = path.join(root, `fixture-${spec.id}`);
    const output = await run("bun", ["scripts/design-performance-fixture.ts", "--frames", String(spec.count), "--layout", spec.layout,
      "--output", folder, ...(spec.complex ? ["--complex"] : []), ...(spec.mixed ? ["--mixed"] : [])]);
    const branchName = (await run("git", ["-C", folder, "symbolic-ref", "--short", "HEAD"])).trim();
    fixtures.push({ ...spec, folder, branchName, fixture: JSON.parse(output.slice(output.indexOf("{"))), authored: await authoredManifest(folder) });
  }
  writeNativeJson(path.join(root, "fixtures.json"), fixtures);
  for (const source of [...(reference ? [{ label: "before", root: reference }] : []), { label: "current", root: repo }]) {
    const sourceManifest = collectNativeSourceManifest(source.root);
    writeNativeJson(path.join(root, `${source.label}-sources.json`), sourceManifest);
    const output = path.join(root, source.label);
    await fs.mkdir(output);
    const stage = path.join(output, "app");
    await fs.mkdir(stage);
    for (const directory of ["node_modules", "apps", "packages", "resources", "styles"]) {
      try { await fs.access(path.join(source.root, directory)); await fs.symlink(path.join(source.root, directory), path.join(stage, directory), "dir"); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    await fs.copyFile(path.join(source.root, "package.json"), path.join(stage, "package.json"));
    const identity = { slug: `design-perf-${randomUUID().slice(0, 8)}`, name: "Zeros Design Performance" };
    const ports = await pickLocalPorts(identity.slug);
    const cdpPort = await freePort();
    const env = { ...localEnvironment({ identity, ...ports }), ZEROS_ISOLATE: "1", ZEROS_NO_ENGINE_HMR: "1", ZEROS_NO_MAIN_HMR: "1",
      ZEROS_DATA_DIR: path.join(output, "profile"), ELECTRON_RENDERER_URL: `http://127.0.0.1:${ports.vitePort}` };
    status(`${source.label}:build`);
    await fs.writeFile(path.join(output, "main-build.log"), await run("pnpm", ["exec", "tsup", "--config", "apps/desktop/electron/tsup.config.ts", "--out-dir", path.join(stage, "dist-electron"), "--metafile"], { cwd: source.root, env }));
    const viteConfig = path.join(output, "vite.config.mjs");
    await fs.writeFile(viteConfig, nativeViteConfiguration(source.root, path.join(output, "vite-cache")));
    viteLog = await fs.open(path.join(output, "vite.log"), "w");
    vite = spawn(process.execPath, [path.join(source.root, "node_modules/vite/bin/vite.js"), "--config", viteConfig, "--host", "127.0.0.1", "--port", String(ports.vitePort), "--strictPort"],
      { cwd: source.root, env, stdio: ["ignore", viteLog.fd, viteLog.fd] });
    const readyBy = Date.now() + 60_000;
    while (!(await fetch(env.ELECTRON_RENDERER_URL).then(r => r.ok, () => false))) {
      assert(Date.now() < readyBy, "Qualification Vite did not start"); await delay(100);
    }
    const result = { label: source.label, sourceDigest: sourceManifest.digest, fixed: [], switches: [], failures: [], rendererEvents: [], memorySamples: [] };
    report.runs.push(result);
    const resourcesAvailable = await fs.access(path.join(source.root, "apps/desktop/src/renderer/features/design-workspace/state/design-renderer-resources.ts")).then(() => true, () => false);
    let layout, enginePid;
    const launch = async () => {
      status(`${source.label}:starting-app`);
      app = await launchNativeElectron({ args: [stage, `--remote-debugging-port=${cdpPort}`, "--remote-debugging-address=127.0.0.1"], cwd: fixtures[0].folder, env, timeout: 90_000 });
      page = await app.firstWindow({ timeout: 60_000 }); page.setDefaultTimeout(30_000);
      page.on("framenavigated", frame => {
        if (frame === page?.mainFrame()) result.rendererEvents.push({ event: "main-frame-navigation", at: new Date().toISOString() });
      });
      page.on("crash", () => result.rendererEvents.push({ event: "renderer-crash", at: new Date().toISOString() }));
      await app.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0];
        win.setBounds({ x: 0, y: 40, width: 1440, height: 1000 });
        // The fixture shares the operator's desktop. Lock only this test
        // window so an incidental resize cannot invalidate later samples.
        win.setResizable(false); win.setMaximizable(false); win.setFullScreenable(false);
        // Physical input must not change an automated workload. CDP input
        // still exercises the real renderer; only this disposable window is inert.
        win.setIgnoreMouseEvents(true);
        win.show();
      });
      await page.addInitScript(() => { globalThis.localStorage.setItem("zeros.column2.ratio", "0.1"); });
      await page.reload();
      await page.waitForFunction(() => globalThis.window.__ZEROS_NATIVE__?.localDevelopment === true);
      await waitForNativeRenderer(page, async () => (await import("/apps/desktop/src/renderer/platform/bridge/active-bridge.ts")).getActiveBridge()?.status === "connected");
      result.runtime = await app.evaluate(({ app }) => ({ electron: process.versions.electron, chromium: process.versions.chrome, mainPid: process.pid,
        userData: app.getPath("userData"), sessionData: app.getPath("sessionData"),
        mockKeychain: app.commandLine.hasSwitch("use-mock-keychain"), backgroundTimersDisabled: app.commandLine.hasSwitch("disable-background-timer-throttling") }));
      assert.equal(result.runtime.userData, env.ZEROS_DATA_DIR);
      assert(!result.runtime.mockKeychain && !result.runtime.backgroundTimersDisabled, "Measure ordinary native Keychain and background scheduling.");
      const processRows = (await run("ps", ["-axo", "pid=,ppid=,comm="])).trim().split("\n").map(row => row.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean);
      const engines = processRows.filter(row => Number(row[2]) === result.runtime.mainPid && /(?:^|\/)bun$/.test(row[3]));
      assert.equal(engines.length, 1, "Identify the isolated source engine before measuring it.");
      enginePid = Number(engines[0][1]);
      result.runtime.enginePid = enginePid;
      const ownedApp = app;
      memoryGuard = await startNativeMemoryGuard({ sample: native, budget: memoryBudget,
        onSample: sample => { result.memorySamples.push(sample); save(); },
        onFailure: async error => {
          result.failures.push(error.message); save();
          // Do not call closeApp here: it joins this guard's pending callback.
          await ownedApp.close();
        },
      });
      if (result.fixed.length) await prepareNativeWorkspaceCatalog(page, fixtures.map(fixture => ({
        folder: fixture.folder, workspaceId: fixture.workspace.workspaceId,
      })));
    };
    const camera = { zoom: 0.5, panX: 64, panY: 96 };
    const open = async (fixture, cameraOverride = camera) => {
      await runNativeRendererAction(page, async folder => {
        const { useWorkspaceStore } = await import("/apps/desktop/src/renderer/state/workspace-store.ts");
        useWorkspaceStore.getState().dispatch({ type: "OPEN_WORKSPACE", folder, repoRoot: folder, chatId: null });
      }, fixture.folder);
      await activateNativeWorkbenchTab(page, fixture.folder, "design");
      const owner = page.locator(`[data-design-retained-workspace="${fixture.workspace.workspaceId}"][aria-hidden="false"]`);
      await owner.locator("[data-design-canvas-viewport]").waitFor();
      await prepareNativeDesignView(page, fixture.workspace.workspaceId, cameraOverride);
      // Static vector surfaces, HTML and decoded pictures can cover a frame.
      await waitForNativeRenderer(page, workspaceId => {
        const owner = globalThis.document.querySelector(`[data-design-retained-workspace="${workspaceId}"][aria-hidden="false"]`);
        return Boolean(owner?.querySelector('iframe[src^="zeros-design:"]:is([data-design-document-ready],[data-design-source-ready]),[data-design-source-vector][data-design-source-ready]') ||
          [...(owner?.querySelectorAll("img[data-design-frame-picture]") ?? [])].some(image => image.complete && image.naturalWidth > 0));
      }, fixture.workspace.workspaceId);
      // Keep startup, style/layout and automatic preview work out of the
      // immediate-navigation sample. This is a natural settle, never a GC.
      await delay(2000);
      const rect = await owner.locator("[data-design-canvas-viewport]").boundingBox();
      assert(rect && rect.width > 650 && rect.height > 500, "The fixed canvas is too small for the reference view.");
      const view = await page.evaluate(async workspaceId => {
        const { useDesignWorkspaceUiStore } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-ui.ts");
        const { zoom, panX, panY, layersVisible, inspectorVisible } = useDesignWorkspaceUiStore.getState().byWorkspace[workspaceId];
        return { zoom, panX, panY, layersVisible, inspectorVisible };
      }, fixture.workspace.workspaceId);
      assert.deepEqual(view, { ...cameraOverride, layersVisible: false, inspectorVisible: false }, "Camera or panels changed between samples.");
      if (!layout) layout = { width: rect.width, height: rect.height };
      assert(Math.abs(rect.width - layout.width) < 1 && Math.abs(rect.height - layout.height) < 1,
        `Canvas size changed between samples: expected ${layout.width}x${layout.height}, observed ${rect.width}x${rect.height}.`);
      return rect;
    };
    const resources = () => resourcesAvailable ? page.evaluate(async () => (await import("/apps/desktop/src/renderer/features/design-workspace/state/design-renderer-resources.ts")).designRendererResources()) : null;
    let memoryRead;
    const native = () => memoryRead ??= sampleNativeApplicationMemory({ app, enginePid }).finally(() => { memoryRead = undefined; });
    const diskUsage = async () => {
      const bytes = async directory => {
        try { const row = await run("du", ["-sk", directory], { timeout: 10_000 }); return Number(row.trim().split(/\s+/)[0]) * 1024; }
        catch { return null; }
      };
      return { sessionAllocatedBytes: await bytes(result.runtime.sessionData), profileAllocatedBytes: await bytes(result.runtime.userData),
        accounting: "Filesystem allocated bytes, separate from the encoded-preview budget; backing files may retain free extents after eviction." };
    };
    const snapshot = async () => ({ at: new Date().toISOString(), native: await native(), resources: await resources(),
      view: await readNativeDesignView(page),
      dom: await page.evaluate(() => {
        const owner = globalThis.document.querySelector('[data-design-retained-workspace][aria-hidden="false"]');
        const frames = [...(owner?.querySelectorAll("[data-design-frame]") ?? [])];
        return { mounted: frames.length, nativeDocuments: owner?.querySelectorAll('iframe[src^="zeros-design:"]').length ?? 0,
          covered: frames.filter(frame => frame.querySelector('iframe[data-design-document-buffer="displayed"][data-design-document-ready],[data-design-source-buffer="displayed"][data-design-source-ready]') ||
            [...frame.querySelectorAll("img[data-design-frame-picture],img[data-design-frame-screenshot],img[data-design-frame-transition-cover]")].some(image =>
              image.complete && image.naturalWidth > 0 && getComputedStyle(image).display !== "none" && getComputedStyle(image).visibility === "visible")).length,
          editingDocuments: owner?.querySelectorAll("iframe[data-design-document-buffer]").length ?? 0,
          sourceDocuments: owner?.querySelectorAll("iframe[data-design-source-buffer]").length ?? 0,
          sourceVectors: owner?.querySelectorAll("[data-design-source-vector][data-design-source-ready]").length ?? 0,
          allDocuments: globalThis.document.querySelectorAll("iframe[data-design-document-buffer],iframe[data-design-source-buffer]").length, devicePixelRatio: globalThis.devicePixelRatio };
      }) });
    await launch();
    for (const fixture of fixtures) {
      fixture.workspace = await page.evaluate(async ({ folder, branchName, id }) => {
        const { upsertProject } = await import("/apps/desktop/src/renderer/state/projects-store.ts");
        const { notifyProjectsChanged, notifyWorkspacesChanged } = await import("/apps/desktop/src/renderer/state/use-projects.ts");
        const { workspaceAdoptExisting } = await import("/apps/desktop/src/renderer/platform/git.ts");
        const project = upsertProject({ repoRoot: folder, repoSlug: `design-performance-${id}`, isGitRepository: true });
        notifyProjectsChanged();
        const workspace = await workspaceAdoptExisting({ repoRoot: folder, worktreePath: folder, branchName, repoSlug: project.repoSlug, organizationId: null });
        notifyWorkspacesChanged(project.repoSlug); return workspace;
      }, fixture);
    }
    for (const fixture of fixtures.filter(fixture => fixture.layout === "fixed-view")) {
      status(`${source.label}:fixed-${fixture.id}`);
      const began = performance.now(); await open(fixture);
      const sample = { id: fixture.id, settleIncludedReadyMs: performance.now() - began, ...(await snapshot()) };
      result.fixed.push(sample);
      await page.screenshot({ path: path.join(output, `fixed-${fixture.id}.png`) });
      await runNativeDesignBaseline({ endpoint: `http://127.0.0.1:${cdpPort}`, output: path.join(output, `idle-${fixture.id}.json`), scenario: `fixed-${fixture.id}`, enginePid });
      save();
    }
    result.layout = { ...layout, camera };
    if (source.label === "current") check("Distant descriptors add no native frame surfaces or live documents at a fixed view",
      result.fixed.filter(row => /^\d+$/.test(row.id)).every(row => row.dom.mounted === result.fixed[0].dom.mounted && row.dom.nativeDocuments === result.fixed[0].dom.nativeDocuments));

    status(`${source.label}:warm-switches`);
    await open(fixtures[0]);
    result.warm = await snapshot();
    // Warm both visited workspaces, then record twenty *actual* transitions.
    await open(fixtures[2]); await open(fixtures[0]);
    for (let index = 0; index < 20; index++) {
      const fixture = fixtures[index % 2 ? 0 : 2];
      await open(fixture);
      assert.equal(await page.locator('[data-design-retained-workspace][aria-hidden="false"]').getAttribute("data-design-retained-workspace"), fixture.workspace.workspaceId);
      result.switches.push({ visit: index + 1, fixture: fixture.id, ...(await snapshot()) }); save();
    }
    check(`${source.label}: twenty settled native transitions preserve the requested workspace`, true);

    status(`${source.label}:capture`);
    const captureSamples = [];
    let sampling = true;
    let capturePhase = "prepare-2", captureSamplingError;
    const sampler = (async () => { while (sampling) { captureSamples.push({ at: performance.now(), phase: capturePhase, processes: await native() }); await delay(100); } })()
      .catch(error => { captureSamplingError = error; sampling = false; });
    result.captures = [];
    try {
      for (const fixture of [fixtures[0], fixtures.find(fixture => fixture.complex)]) {
        capturePhase = `prepare-${fixture.id}`;
        await open(fixture);
        await selectNativeDesignFrame(page, fixture.workspace.workspaceId);
        if (resourcesAvailable) await waitForNativeRenderer(page, async () => {
          const value = (await import("/apps/desktop/src/renderer/features/design-workspace/state/design-renderer-resources.ts")).designRendererResources();
          return value.captures.running === 0 && value.captures.queued === 0 && value.counters.tileRequests.current === 0;
        });
        capturePhase = `capture-${fixture.id}`;
        for (let iteration = 0; iteration < 8; iteration++) {
          const began = performance.now();
          const capture = await page.evaluate(async workspaceId => {
            const { designFrameRuntime } = await import("/apps/desktop/src/renderer/platform/bridge/design-frame-runtime.ts");
            const frame = globalThis.document.querySelector(`[data-design-retained-workspace="${workspaceId}"] iframe[data-design-document-ready]`)?.closest("[data-design-frame]")?.getAttribute("data-design-frame");
            const runtime = designFrameRuntime(workspaceId, frame);
            if (!runtime) throw new Error("No ready runtime for capture.");
            return runtime.captureScreenshot(null, 1);
          }, fixture.workspace.workspaceId);
          const png = Buffer.from(capture.dataUrl.split(",")[1], "base64");
          if (!iteration) await fs.writeFile(path.join(output, `runtime-capture-${fixture.id}.png`), png);
          result.captures.push({ fixture: fixture.id, ms: performance.now() - began, width: capture.width, height: capture.height, bytes: png.length, sha256: createHash("sha256").update(png).digest("hex") });
        }
      }
    } finally { sampling = false; await sampler; }
    writeNativeJson(path.join(output, "capture-process-samples.json"), captureSamples);
    result.captureSampleCount = captureSamples.length;
    if (captureSamplingError) throw captureSamplingError;
    for (const fixture of [fixtures[0], fixtures.find(fixture => fixture.mixed)]) {
    await open(fixture);
    const textFrame = fixture.mixed ? await page.locator(`[data-design-retained-workspace="${fixture.workspace.workspaceId}"] [data-design-frame-kind="text"]`).first().getAttribute("data-design-frame") : undefined;
    await selectNativeDesignFrame(page, fixture.workspace.workspaceId, textFrame);
    const portable = await page.evaluate(async ({ workspaceId, mixed }) => {
      const { getActiveBridge } = await import("/apps/desktop/src/renderer/platform/bridge/active-bridge.ts");
      const { bridgeDesignFrame, bridgeDesignFoundationOpen, bridgeDesignPreview } = await import("/apps/desktop/src/renderer/platform/bridge/design-bridge.ts");
      const { workspaceOp } = await import("/apps/desktop/src/renderer/platform/bridge/workspace-bridge.ts");
      const { useDesignWorkspaceUiStore } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-ui.ts");
      const frame = globalThis.document.querySelector(`[data-design-retained-workspace="${workspaceId}"] ${mixed ? '[data-design-frame-kind="text"] ' : ''}iframe[data-design-document-ready]`)?.closest("[data-design-frame]")?.getAttribute("data-design-frame");
      const bridge = getActiveBridge();
      const frameDocument = await bridgeDesignFrame(bridge, workspaceId, frame);
      const foundation = await bridgeDesignFoundationOpen(bridge, workspaceId, frame);
      const preview = await bridgeDesignPreview(bridge, workspaceId, { directoryId: useDesignWorkspaceUiStore.getState().byWorkspace[workspaceId].directoryId,
        frame, sourceVersion: frameDocument.sourceVersion, theme: null, maxDimension: 560 }, { priority: "explicit" });
      const exported = await workspaceOp(bridge, "design.capture", { workspaceId, frame, expectedRevision: foundation.foundation.revision, width: 560, height: 360 });
      return { preview, exported };
    }, { workspaceId: fixture.workspace.workspaceId, mixed: fixture.mixed === true });
    assert(!portable.preview.stale, "The preview must match the saved generation.");
    for (const [name, artifact] of Object.entries(portable)) {
      const png = Buffer.from(artifact.data, "base64");
      await fs.writeFile(path.join(output, `${fixture.mixed ? "text-" : ""}${name}.png`), png);
      artifact.pixels = await app.evaluate(({ nativeImage }, data) => {
        const image = nativeImage.createFromBuffer(Buffer.from(data, "base64"));
        const size = image.getSize(), pixels = image.toBitmap();
        let transparent = 0, painted = 0;
        for (let offset = 3; offset < pixels.length; offset += 4) {
          if (pixels[offset] === 0) transparent++;
          else painted++;
        }
        return { ...size, transparent, painted, cornerAlpha: pixels[pixels.length - 1] };
      }, artifact.data);
      artifact.sha256 = createHash("sha256").update(png).digest("hex");
      artifact.bytes = png.length;
      delete artifact.data;
    }
    result[fixture.mixed ? "portableText" : "portable"] = portable;
    check(`${source.label}: ${fixture.mixed ? "transparent text" : "HTML"} native preview and exact-revision export preserve the CSS viewport`, Object.values(portable).every(value => value.width === 560 && value.height === 360));
    if (source.label === "current" && fixture.mixed)
      check("Native text preview and export retain painted glyphs on a transparent canvas",
        Object.values(portable).every(value => value.pixels.transparent > 0 && value.pixels.painted > 0 && value.pixels.cornerAlpha === 0));
    }

    status(`${source.label}:hidden-idle`);
    await open(fixtures[0]);
    await activateNativeWorkbenchTab(page, fixtures[0].folder, "files");
    await delay(12_000);
    result.hidden = await snapshot();
    const idleStart = performance.now();
    await delay(60_000);
    result.hiddenIdle = { seconds: (performance.now() - idleStart) / 1000, after: await snapshot() };
    if (source.label === "current") check("Current hidden native documents, display leases and capture work retire with bounded warm caches",
      nativeDesignHiddenResourcesRetired(result.hidden.resources));

    status(`${source.label}:overview`);
    const overview = fixtures.find(fixture => fixture.id === "overview-256");
    const overviewCamera = { zoom: Math.min((layout.width - 64) / 10240, (layout.height - 160) / 7040), panX: 32, panY: 96 };
    await open(overview, overviewCamera);
    const overviewView = await readNativeDesignView(page);
    const expectedOverview = { ...overviewView, workspaceId: overview.workspace.workspaceId, camera: overviewCamera, viewport: layout };
    assertNativeDesignView(overviewView, expectedOverview);
    const overviewStarted = performance.now();
    let overviewSnapshot;
    while (performance.now() - overviewStarted < 90_000) {
      overviewSnapshot = await snapshot();
      assertNativeDesignView(overviewSnapshot.view, expectedOverview);
      if (overviewSnapshot.dom.covered === 256) break;
      await delay(1000);
    }
    result.overview = { readyMs: performance.now() - overviewStarted, ...overviewSnapshot };
    await page.screenshot({ path: path.join(output, "overview.png") });
    if (source.label === "current") {
      check("All 256 native overview frames obtain pixels", result.overview.dom.covered === 256);
      check("All 256 eligible native overview frames retain vector surfaces without preview captures",
        result.overview.dom.sourceVectors === 256 && result.overview.resources.sourceSurfaces.frames === 256 &&
        result.overview.dom.sourceDocuments <= 12 && result.overview.resources.sourceLoads.active === 0 &&
        result.overview.resources.previews.producing === 0 && result.overview.resources.previews.demanded === 0);
    }

    status(`${source.label}:pan-trace`);
    await open(fixtures[3]);
    const trace = await page.context().newCDPSession(page);
    await trace.send("Tracing.start", { transferMode: "ReturnAsStream", traceConfig: { includedCategories: ["benchmark", "cc", "gpu", "input", "latencyInfo", "viz", "devtools.timeline", "disabled-by-default-devtools.timeline.frame"] } });
    const rect = await page.locator('[data-design-retained-workspace][aria-hidden="false"] [data-design-canvas-viewport]').boundingBox();
    await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
    // Chromium generates continuous wheel input at its gesture cadence. A
    // Playwright wheel call followed by a sleep would wait for delivery *and*
    // sleep, unintentionally cutting input frequency and biasing frame gaps.
    result.panWorkload = { kind: "CDP synthetic mouse scroll", pixelsPerSecond: 800, distancePerLeg: 640, legs: 4 };
    for (const distance of [-640, 640, -640, 640]) await trace.send("Input.synthesizeScrollGesture", {
      x: rect.x + rect.width / 2, y: rect.y + rect.height / 2,
      xDistance: distance, yDistance: 0, speed: 800, gestureSourceType: "mouse", preventFling: true,
    });
    await delay(1000);
    const complete = new Promise(resolve => trace.once("Tracing.tracingComplete", resolve));
    await trace.send("Tracing.end");
    const { stream } = await complete;
    const traceFile = await fs.open(path.join(output, "pan-trace.json"), "w");
    try { for (;;) { const part = await trace.send("IO.read", { handle: stream }); await traceFile.write(part.base64Encoded ? Buffer.from(part.data, "base64") : part.data); if (part.eof) break; } }
    finally { await traceFile.close(); await trace.send("IO.close", { handle: stream }); await trace.detach(); }
    result.afterPan = await snapshot();

    if (source.label === "current") {
      status("current:cache-pressure");
      result.diskBeforePressure = await diskUsage();
      result.cacheBefore = await page.evaluate(async () => {
        const { createIndexedDbDesignPreviewStore } = await import("/apps/desktop/src/renderer/platform/design-preview-store.ts");
        const rows = await createIndexedDbDesignPreviewStore().readIndex();
        return { entries: rows.length, bytes: rows.reduce((sum, row) => sum + row.bytes, 0) };
      });
      await activateNativeWorkbenchTab(page, fixtures[3].folder, "files");
      // Deliberately overfill *only the disposable preview store*. This models
      // cache leftovers across restart; it is excluded from memory benchmarks.
      result.injectedCache = await page.evaluate(async () => {
        const { createIndexedDbDesignPreviewStore } = await import("/apps/desktop/src/renderer/platform/design-preview-store.ts");
        const { designPreviewKey, designPreviewFrameKey } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-frame-previews.ts");
        const store = createIndexedDbDesignPreviewStore();
        const put = Array.from({ length: 80 }, (_, index) => {
          const owner = { scope: "local", workspaceId: "qualification-pressure", directoryId: "qualification-pressure" };
          const file = `pressure-${index}.html`, theme = null, level = "overview", sourceVersion = "qualification-pressure";
          const key = designPreviewKey({ owner, file, theme, level, sourceVersion });
          // Distinct deterministic bytes avoid backing-store deduplication.
          // These synthetic, unrequested rows model disposable cache debris.
          const bytes = new Uint8Array(768 * 1024);
          let random = index + 1;
          for (let offset = 0; offset < bytes.length; offset++) { random ^= random << 13; random ^= random >>> 17; random ^= random << 5; bytes[offset] = random & 255; }
          const blob = new globalThis.Blob([bytes], { type: "image/png" });
          return { record: { key, blob }, entry: { key, frameKey: designPreviewFrameKey(owner, file, theme), workspaceId: owner.workspaceId, level, sourceVersion,
            width: 384, height: 256, bytes: blob.size, savedAt: index, readAt: index } };
        });
        await store.commit({ put });
        return { entries: put.length, bytes: put.reduce((sum, item) => sum + item.entry.bytes, 0), synthetic: true };
      });
      await closeApp(); await launch(); await open(fixtures[0]);
      await waitForNativeRenderer(page, async () => {
        const { createIndexedDbDesignPreviewStore } = await import("/apps/desktop/src/renderer/platform/design-preview-store.ts");
        const rows = await createIndexedDbDesignPreviewStore().readIndex();
        return rows.reduce((sum, row) => sum + row.bytes, 0) <= 48 * 1024 * 1024;
      });
      result.cacheAfterRestart = await snapshot();
      result.diskAfterPressureRestart = await diskUsage();
      check("Native restart prunes preview cache pressure to the encoded disk budget", result.cacheAfterRestart.resources.previews.diskBytes <= 48 * 1024 * 1024);
      await activateNativeWorkbenchTab(page, fixtures[0].folder, "files");
      result.purgedCacheEntries = await page.evaluate(async () => {
        const { createIndexedDbDesignPreviewStore } = await import("/apps/desktop/src/renderer/platform/design-preview-store.ts");
        const store = createIndexedDbDesignPreviewStore(); const rows = await store.readIndex();
        await store.commit({ remove: rows.map(row => row.key) }); return rows.length;
      });
      await closeApp(); await launch(); await open(fixtures[0]);
      result.cacheAfterPurge = await snapshot();
      result.diskAfterPurgeRestart = await diskUsage();
      await page.screenshot({ path: path.join(output, "after-cache-purge.png") });
      check("Cache eviction and a second restart preserve usable native source rendering", result.cacheAfterPurge.dom.nativeDocuments > 0 && result.cacheAfterPurge.dom.covered >= 2);
      // A distinct robustness scenario, after every memory benchmark. Do not
      // use pressure-induced GC to manufacture a natural residency plateau.
      const pressure = await page.context().newCDPSession(page);
      await pressure.send("Memory.simulatePressureNotification", { level: "critical" });
      await pressure.detach(); await delay(2000);
      result.simulatedMemoryPressure = await snapshot();
      check("Simulated Chromium memory pressure preserves the visible native documents", result.simulatedMemoryPressure.dom.covered >= 2);
    }
    await closeApp(); vite.kill("SIGTERM"); await viteLog.close(); vite = undefined; viteLog = undefined;
    check(`${source.label}: source inputs remain unchanged`, collectNativeSourceManifest(source.root).digest === sourceManifest.digest);
    for (const fixture of fixtures) assert.deepEqual(await authoredManifest(fixture.folder), fixture.authored, "Qualification changed authored source.");
    check(`${source.label}: captures, cache pressure and navigation preserve authored files`, true);
    save();
  }
} catch (error) {
  report.failures.push(error.stack ?? String(error)); process.exitCode = 1;
  if (page) { await page.screenshot({ path: path.join(root, "failure.png") }).catch(() => {}); report.failureText = await page.locator("body").innerText().then(text => text.slice(0, 4000), () => "unavailable"); }
} finally {
  clearTimeout(deadline);
  await closeApp().catch(error => { report.failures.push(`App close: ${error.message}`); process.exitCode = 1; });
  vite?.kill("SIGTERM"); await viteLog?.close();
  report.finishedAt = new Date().toISOString(); status(report.failures.length ? "failed" : "complete");
}
