#!/usr/bin/env node
/* global window, document, CSS, Element, PerformanceObserver, requestAnimationFrame,
   cancelAnimationFrame, getComputedStyle, parent, performance, innerWidth, innerHeight */
// Diagnostic input-to-DOM evidence, not CI timing assertions or compositor
// qualification. The same observer cost is present in before/after runs.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "@playwright/test";
import { designFrameElementBox } from "./ui-smoke-design-helpers.mjs";

const { values } = parseArgs({ options: {
  "base-url": { type: "string", default: "http://127.0.0.1:5299" },
  "source-root": { type: "string", default: "." },
  "build-dir": { type: "string" },
  out: { type: "string", default: ".context/measure/v2-manipulation" },
  delay: { type: "string", default: "400" },
  only: { type: "string" },
  production: { type: "boolean", default: false },
  profile: { type: "boolean", default: false },
} });
const sourceRoot = resolve(values["source-root"]), output = resolve(values.out);
await mkdir(output, { recursive: true });
const wants = name => !values.only || values.only.split(",").includes(name);
const identity = async () => {
  const archived = await readFile(resolve(sourceRoot, ".baseline-source.json"), "utf8").then(JSON.parse).catch(() => null);
  const files = (Array.isArray(archived?.files) ? archived.files : archived
    ? execFileSync("git", ["ls-tree", "-r", "--name-only", archived.revision], { encoding: "utf8" }).split("\n")
    : execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: sourceRoot, encoding: "utf8" }).split("\0"))
    .filter(file => /^(apps\/desktop\/src\/|packages\/|styles\/)/.test(file) || ["vite.config.ts", "package.json", "pnpm-lock.yaml"].includes(file)).sort();
  if (files.some(file => typeof file !== "string" || file.split("/").some(part => part === ".." || part === ".")))
    throw new Error("The archived source manifest contains an invalid path.");
  const digest = createHash("sha256");
  for (const file of files) digest.update(file).update("\0").update(await readFile(resolve(sourceRoot, file))).update("\0");
  return { revision: archived?.revision ?? execFileSync("git", ["rev-parse", "HEAD"], { cwd: sourceRoot, encoding: "utf8" }).trim(),
    sourceDigest: digest.digest("hex"), archived,
    runnerDigest: createHash("sha256").update(await readFile(new URL(import.meta.url))).digest("hex") };
};
const report = { recordedAt: new Date().toISOString(), build: values.production ? "production" : "development",
  profiling: values.profile, sourceBefore: await identity(), viewport: { width: 1600, height: 1000 },
  engineDelayMs: Math.max(0, Math.min(500, Number(values.delay) || 0)), scenarios: [], errors: [], consoleErrors: [],
  evidence: "Linux Chromium rAF DOM/geometry observations. Includes observer overhead; not compositor, GPU or native macOS latency qualification.",
  fixture: "Real renderer/runtime, bounded in-memory Local engine fixture; packaged CSP removed only from emitted fixture HTML.",
};
const workspaceId = "ws_design_harness";
let server, browser, page, cdp;
const iframeSelector = '[data-design-frame="home.html"] iframe[data-design-document-buffer="displayed"][data-design-document-ready]';
const runtime = () => page.frameLocator(iframeSelector);
const selected = id => page.locator(`[data-design-element-overlay="${id}"][data-design-selected-element]`);
const nextPaints = () => page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));

async function start() {
  if (values.production) {
    const origin = new URL(values["base-url"]);
    if (!["127.0.0.1", "localhost"].includes(origin.hostname)) throw new Error("The fixture server must bind to loopback.");
    const { build, preview } = await import("vite");
    const outDir = values["build-dir"] ? resolve(values["build-dir"]) : resolve(output, "build");
    if (values["build-dir"]) {
      const built = JSON.parse(await readFile(resolve(outDir, "measurement-source.json"), "utf8"));
      if (built.sourceDigest !== report.sourceBefore.sourceDigest || built.profiling !== values.profile)
        throw new Error("The reused build does not match the requested source/profiling mode.");
    } else {
      await build({ root: sourceRoot, configFile: resolve(sourceRoot, "vite.config.ts"), mode: "ui-smoke", logLevel: "warn",
      cacheDir: resolve(output, "vite-cache"), define: { "process.env.NODE_ENV": '"production"' },
      ...(values.profile ? { resolve: { alias: [{ find: /^react-dom$/, replacement: "react-dom/profiling" }] }, esbuild: { keepNames: true } } : {}),
      build: { outDir, emptyOutDir: true, rollupOptions: { input: resolve(sourceRoot, "apps/desktop/src/renderer/harnesses/harness-design-workspace.html") } } });
    const htmlPath = resolve(outDir, "apps/desktop/src/renderer/harnesses/harness-design-workspace.html");
    const html = await readFile(htmlPath, "utf8");
    const fixtureHtml = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, "");
    if (fixtureHtml === html) throw new Error("Expected packaged CSP in the emitted fixture HTML.");
      await writeFile(htmlPath, fixtureHtml);
      await writeFile(resolve(outDir, "measurement-source.json"), JSON.stringify({ ...report.sourceBefore, profiling: values.profile }, null, 2));
    }
    server = await preview({ root: sourceRoot, configFile: resolve(sourceRoot, "vite.config.ts"), mode: "ui-smoke", logLevel: "warn",
      build: { outDir }, preview: { host: "127.0.0.1", port: Number(origin.port || 5299), strictPort: true } });
  }
  browser = await chromium.launch();
  report.browser = browser.version();
  page = await browser.newPage({ viewport: report.viewport, deviceScaleFactor: 1 });
  page.setDefaultTimeout(15_000);
  page.on("pageerror", error => report.errors.push(error.message));
  page.on("console", message => { if (message.type() === "error" && report.consoleErrors.length < 32) report.consoleErrors.push(message.text()); });
  cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
}

async function load(node = "home-hero", extra = {}) {
  const url = new URL("/apps/desktop/src/renderer/harnesses/harness-design-workspace.html", values["base-url"]);
  for (const [key, value] of Object.entries({ layoutGestures: "1", measureManipulation: "1", engineDelayMs: String(report.engineDelayMs),
    ...(values.profile ? { profileContinuity: "1" } : {}), ...extra })) url.searchParams.set(key, value);
  await page.goto(url.href, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__zerosHarnessDesignSurface?.measurement);
  await page.locator('[data-design-frame-row="home.html"]').click();
  await page.locator(iframeSelector).waitFor();
  if (node) {
    const row = page.locator(`[data-design-sidebar-panel] [data-design-layer-id="${node}"]`);
    for (let attempt = 0; attempt < 8 && !await row.isVisible(); attempt++) {
      const folded = page.locator('[data-design-sidebar-panel] [role="treeitem"][aria-expanded="false"]:visible').first();
      if (!await folded.count()) break;
      await folded.locator("[data-layer-disclosure]").click();
      await nextPaints();
    }
    await row.click();
  }
  await page.getByLabel("Rotation", { exact: true }).waitFor();
  await page.waitForFunction(id => !window.__zerosHarnessDesignSurface.measurement.editing(id), workspaceId);
  await nextPaints();
}

// The sandboxed runtime has an opaque origin. Its own rAF samples use the same
// monotonic epoch as the parent and post only diagnostic numbers/styles. This
// also preserves observations when the old runtime is later detached.
async function installRuntimeSampler(frame, spec, key) {
  if (frame === page.mainFrame()) return;
  try {
    const host = await frame.frameElement();
    const file = await host.evaluate(node => node.closest("[data-design-frame]")?.getAttribute("data-design-frame"));
    if (!file) return;
    await frame.evaluate(({ file, nodeId, key }) => {
      window.__zerosManipulationRuntime?.stop();
      let request;
      const read = () => {
        const node = nodeId ? document.querySelector(`[data-oid="${CSS.escape(nodeId)}"]`) : document.body;
        const rect = node?.getBoundingClientRect();
        const style = node ? getComputedStyle(node) : null;
        parent.postMessage({ zerosManipulation: key, file, epochMs: performance.timeOrigin + performance.now(),
          node: nodeId, present: Boolean(node), rect: rect?.toJSON() ?? null, viewport: { width: innerWidth, height: innerHeight },
          visible: Boolean(rect?.width && rect.height && style?.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) > 0),
          styles: style ? { paddingLeft: style.paddingLeft, paddingTop: style.paddingTop, borderRadius: style.borderRadius,
            transform: style.transform, rotate: style.rotate, width: style.width, height: style.height, position: style.position, left: style.left, top: style.top,
            opacity: style.opacity, display: style.display } : null }, "*");
        request = requestAnimationFrame(read);
      };
      window.__zerosManipulationRuntime = { stop: () => cancelAnimationFrame(request) };
      read();
    }, { file, nodeId: spec.node ?? null, key });
  } catch { /* A staging runtime can be replaced before instrumentation. */ }
}

async function beginProbe(spec) {
  const key = `manipulation-${Date.now()}`;
  await page.evaluate(({ spec, key, workspaceId }) => {
    let request;
    const samples = [], runtimeSamples = [], inputs = [], longTasks = [];
    const c = window.__zerosHarnessDesignSurface;
    const rect = node => node?.getBoundingClientRect().toJSON() ?? null;
    const visible = node => {
      if (!node?.getBoundingClientRect().width) return false;
      for (let element = node; element instanceof Element; element = element.parentElement) {
        const style = getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
      }
      return true;
    };
    const read = () => {
      const view = c.ui.getState().byWorkspace[workspaceId];
      const cached = c.snapshots.peekSnapshot(workspaceId);
      const file = spec.frame ?? "home.html";
      const frames = [...document.querySelectorAll("[data-design-frame]")].map(frame => {
        const iframe = frame.querySelector('iframe[data-design-document-buffer="displayed"][data-design-document-ready]');
        return { file: frame.getAttribute("data-design-frame"), rect: rect(frame), iframe: visible(iframe) ? rect(iframe) : null,
          picture: [...frame.querySelectorAll("img")].some(image => visible(image) && image.complete && image.naturalWidth > 0) };
      });
      const overlay = spec.node ? document.querySelector(`[data-design-element-overlay="${CSS.escape(spec.node)}"][data-design-selected-element]`) : document.querySelector(`[data-design-frame="${CSS.escape(file)}"]`);
      const ghost = spec.node ? document.querySelector(`[data-design-drag-preview="${CSS.escape(spec.node)}"]`) : null;
      const inspector = document.querySelector("[data-design-inspector]");
      const layers = document.querySelector('[aria-label="Design layers"]');
      const geometry = cached.data?.frames.find(frame => frame.file === file);
      const activeFrame = frames.find(frame => frame.file === view?.selectedFrame);
      return { epochMs: performance.timeOrigin + performance.now(), frames, overlay: visible(overlay) ? rect(overlay) : null,
        ghost: visible(ghost) ? rect(ghost) : null, ghostPixels: Boolean(ghost?.querySelector("img")?.complete),
        selectedFrame: view?.selectedFrame ?? null, selectedNode: view?.selectedNodeId ?? null,
        authoritative: geometry ? { sourceVersion: geometry.sourceVersion, x: geometry.x, y: geometry.y, width: geometry.width, height: geometry.height } : null,
        fields: Object.fromEntries([...inspector?.querySelectorAll("input[aria-label]") ?? []].map(input => [input.getAttribute("aria-label"), input.value])),
        pending: c.measurement.editing(workspaceId) || cached.loading || cached.refreshing || c.measurement.requests.some(item => item.released === null),
        nothingSelected: /Nothing selected/.test(inspector?.textContent ?? ""), pendingLayers: /Loading frame|Preparing frame/.test(layers?.textContent ?? ""),
        toasts: [...document.querySelectorAll('[data-sonner-toast]:not([data-removed="true"])')].slice(0, 8).map(toast => toast.textContent?.trim() ?? ""),
        canvasBlank: Boolean(view?.selectedFrame && !activeFrame?.iframe && !activeFrame?.picture && !visible(ghost)),
      };
    };
    const before = read(), started = performance.now();
    const tick = () => { if (samples.length < 1800) samples.push(read()); if (samples.length < 1800) request = requestAnimationFrame(tick); };
    const onRuntime = event => { if (event.data?.zerosManipulation === key && runtimeSamples.length < 7200) runtimeSamples.push(event.data); };
    const onInput = event => { if (inputs.length < 256) inputs.push({ type: event.type, key: event.key, buttons: event.buttons, x: event.clientX, y: event.clientY, epochMs: performance.timeOrigin + performance.now() }); };
    const observer = new PerformanceObserver(list => { for (const item of list.getEntries()) if (longTasks.length < 128) longTasks.push({ startTime: item.startTime, duration: item.duration }); });
    observer.observe({ type: "longtask", buffered: false });
    window.addEventListener("message", onRuntime);
    for (const type of ["pointerdown", "pointermove", "pointerup", "keydown"]) document.addEventListener(type, onInput, true);
    request = requestAnimationFrame(tick);
    window.__zerosManipulationProbe = {
      ready: () => samples.length >= 3 && samples.slice(-3).every(sample => !sample.pending) &&
        (JSON.stringify(read().authoritative) !== JSON.stringify(before.authoritative) || read().toasts.length > 0 ||
          spec.pendingEdit && c.measurement.requests.some(item => item.op === "design.history.undo" && item.started >= started && item.released !== null)),
      stop: () => {
        cancelAnimationFrame(request); observer.disconnect(); window.removeEventListener("message", onRuntime);
        for (const type of ["pointerdown", "pointermove", "pointerup", "keydown"]) document.removeEventListener(type, onInput, true);
        return { before, started, timeOrigin: performance.timeOrigin, samples, runtimeSamples, inputs, longTasks,
          resources: c.resources(), requests: c.measurement.requests.filter(item => item.started >= started),
          commits: c.measurement.commits.filter(item => item.startTime >= started) };
      },
    };
  }, { spec, key, workspaceId });
  const attach = frame => { void installRuntimeSampler(frame, spec, key); };
  page.on("framenavigated", attach);
  await Promise.all(page.frames().map(frame => installRuntimeSampler(frame, spec, key)));
  await nextPaints();
  return async () => {
    page.off("framenavigated", attach);
    await Promise.all(page.frames().filter(frame => frame !== page.mainFrame()).map(frame => frame.evaluate(() => window.__zerosManipulationRuntime?.stop()).catch(() => {})));
    return page.evaluate(() => window.__zerosManipulationProbe.stop());
  };
}

const deltaRect = (left, right) => !left || !right ? null : Math.max(...["x", "y", "width", "height"].map(key => Math.abs(left[key] - right[key])));
function summarize(raw, spec) {
  const input = raw.inputs.find(event => spec.input === "keydown" ? event.type === "keydown" && event.key.toLowerCase() === "z" : event.type === "pointermove" && event.buttons === 1);
  if (!input) return { failure: "The requested input event was not observed." };
  const samples = raw.samples.filter(sample => sample.epochMs >= input.epochMs);
  const baselineRuntime = raw.runtimeSamples.find(sample => sample.file === spec.frame && sample.present);
  const baselineParent = raw.before.frames.find(frame => frame.file === spec.frame)?.iframe;
  const baselinePixels = baselineRuntime?.rect && baselineParent ? {
    x: baselineParent.x + baselineRuntime.rect.x * baselineParent.width / baselineRuntime.viewport.width,
    y: baselineParent.y + baselineRuntime.rect.y * baselineParent.height / baselineRuntime.viewport.height,
    width: baselineRuntime.rect.width * baselineParent.width / baselineRuntime.viewport.width,
    height: baselineRuntime.rect.height * baselineParent.height / baselineRuntime.viewport.height,
  } : null;
  const observed = samples.map(sample => {
    const live = raw.runtimeSamples.filter(item => item.present && item.visible && (spec.node || item.file === spec.frame) && Math.abs(item.epochMs - sample.epochMs) < 28)
      .sort((a, b) => Math.abs(a.epochMs - sample.epochMs) - Math.abs(b.epochMs - sample.epochMs))[0];
    const parent = live && sample.frames.find(frame => frame.file === live.file)?.iframe;
    const pixels = sample.ghost && sample.ghostPixels ? sample.ghost : parent && live.rect ? {
      x: parent.x + live.rect.x * parent.width / live.viewport.width,
      y: parent.y + live.rect.y * parent.height / live.viewport.height,
      width: live.rect.width * parent.width / live.viewport.width, height: live.rect.height * parent.height / live.viewport.height,
    } : null;
    return { ms: sample.epochMs - input.epochMs, overlay: sample.overlay, pixels, offset: deltaRect(sample.overlay, pixels),
      frameMoved: deltaRect(sample.overlay, raw.before.overlay) > 0.5,
      pixelsMoved: deltaRect(pixels, baselinePixels) > 0.5,
      runtimeSampleSkewMs: live ? live.epochMs - sample.epochMs : null,
      runtimeChanged: live && baselineRuntime && (deltaRect(live.rect, baselineRuntime.rect) > 0.5 || JSON.stringify(live.styles) !== JSON.stringify(baselineRuntime.styles)),
      styles: live?.styles ?? null, pixelsMissing: Boolean(spec.node && sample.overlay && !pixels),
      clipped: Boolean(parent && live && !sample.ghost && (live.rect.x < -1 || live.rect.y < -1 || live.rect.right > live.viewport.width + 1 || live.rect.bottom > live.viewport.height + 1)),
      pending: sample.pending, nothingSelected: sample.nothingSelected, pendingLayers: sample.pendingLayers, canvasBlank: sample.canvasBlank };
  });
  const changed = observed.find(sample => spec.node ? sample.runtimeChanged || sample.pixelsMoved : sample.frameMoved);
  const finalState = raw.samples.at(-1)?.authoritative;
  const lastUnsettled = samples.findLastIndex(sample => sample.pending || JSON.stringify(sample.authoritative) !== JSON.stringify(finalState));
  const finalVisual = observed.at(-1);
  const lastVisualChange = observed.findLastIndex(sample => deltaRect(sample.pixels, finalVisual?.pixels) > 0.5 ||
    JSON.stringify(sample.styles) !== JSON.stringify(finalVisual?.styles));
  const released = raw.inputs.findLast(event => event.type === "pointerup");
  const offsets = observed.filter(sample => sample.offset !== null).map(sample => sample.offset).sort((a, b) => a - b);
  const flags = ["nothingSelected", "pendingLayers", "canvasBlank", "pixelsMissing", "clipped"];
  return { inputEpochMs: input.epochMs, firstChangedMs: changed?.ms ?? null,
    firstOverlayChangedMs: observed.find(sample => sample.frameMoved)?.ms ?? null,
    stableAuthorityMs: samples[lastUnsettled + 1] ? samples[lastUnsettled + 1].epochMs - input.epochMs : null,
    stableVisualMs: observed[lastVisualChange + 1]?.ms ?? null,
    releaseToAuthorityMs: released && samples[lastUnsettled + 1] ? samples[lastUnsettled + 1].epochMs - released.epochMs : null,
    maxBoxPixelOffset: offsets.at(-1) ?? null, p95BoxPixelOffset: offsets[Math.min(offsets.length - 1, Math.floor(offsets.length * .95))] ?? null,
    ...Object.fromEntries(flags.map(flag => [flag, observed.filter(sample => sample[flag]).length])),
    sampledFrames: observed.length, offsetsMeasured: offsets.length, observations: observed,
    react: { commits: raw.commits.length, renderMs: raw.commits.reduce((sum, commit) => sum + commit.actualDuration, 0) },
  };
}

async function measure(name, spec, action) {
  const stop = await beginProbe(spec);
  const metricsBefore = await cdp.send("Performance.getMetrics");
  let failure = null;
  try {
    await action();
    await page.waitForFunction(() => window.__zerosManipulationProbe.ready());
    // Observe the hand-off after the first settled authority, including covers.
    await page.waitForTimeout(300);
    await nextPaints();
  } catch (error) { failure = error.message; }
  const raw = await stop();
  const productErrors = [...new Set(raw.samples.flatMap(sample => sample.toasts))];
  if (productErrors.length) failure ??= productErrors.join("; ");
  const metricsAfter = await cdp.send("Performance.getMetrics");
  const metrics = Object.fromEntries(["TaskDuration", "ScriptDuration", "LayoutDuration", "RecalcStyleDuration", "JSHeapUsedSize"].map(name => {
    const before = metricsBefore.metrics.find(metric => metric.name === name)?.value ?? 0;
    const after = metricsAfter.metrics.find(metric => metric.name === name)?.value ?? 0;
    return [name, { before, after, delta: after - before }];
  }));
  const entry = { name, spec, failure, productErrors, ...summarize(raw, spec), metrics, ...raw };
  if (!entry.failure && entry.firstChangedMs === null) entry.failure = "No changed runtime style or presented geometry was observed after input.";
  report.scenarios.push(entry);
  await writeFile(resolve(output, `${name}.json`), JSON.stringify(entry, null, 2));
  await page.screenshot({ path: resolve(output, `${name}.png`) });
  await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ name, failure: entry.failure, firstChangedMs: entry.firstChangedMs, stableAuthorityMs: entry.stableAuthorityMs,
    maxBoxPixelOffset: entry.maxBoxPixelOffset, pixelsMissing: entry.pixelsMissing, clipped: entry.clipped, canvasBlank: entry.canvasBlank }));
}

async function drag(start, end) {
  await page.mouse.move(start.x, start.y); await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 16 });
  await nextPaints(); await page.mouse.up();
}
const center = box => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
async function scrub(name, label, property) {
  if (!wants(name)) return;
  await load();
  const box = await page.getByRole("button", { name: `Scrub ${label}`, exact: true }).boundingBox();
  const start = center(box);
  await measure(name, { frame: "home.html", node: "home-hero", property }, () => drag(start, { x: start.x + 28, y: start.y }));
}

try {
  await start();
  if (wants("frame-drag")) {
    await load(null);
    const start = center(await page.locator('[data-design-frame="home.html"] [data-design-frame-label]').boundingBox());
    await measure("frame-drag", { frame: "home.html" }, () => drag(start, { x: start.x + 60, y: start.y + 30 }));
  }
  if (wants("child-drag")) {
    await load("home-heading", { autoLayout: "1" });
    const start = center(await designFrameElementBox(runtime().owner(), runtime().locator('[data-oid="home-heading"]')));
    await measure("child-drag", { frame: "home.html", node: "home-heading" }, () => drag(start, { x: start.x + 20, y: start.y + 20 }));
  }
  if (wants("cross-frame-drag")) {
    await load("home-heading");
    const source = await page.locator('[data-design-frame="home.html"]').boundingBox();
    const start = center(await designFrameElementBox(runtime().owner(), runtime().locator('[data-oid="home-heading"]')));
    await measure("cross-frame-drag", { frame: "home.html", node: "home-heading" }, () => drag(start, { x: source.x + source.width / 2, y: source.y + source.height + 50 }));
  }
  if (wants("resize")) {
    await load();
    const start = center(await selected("home-hero").locator('[data-design-resize-edge="e"]').boundingBox());
    await measure("resize", { frame: "home.html", node: "home-hero" }, () => drag(start, { x: start.x + 28, y: start.y }));
  }
  if (wants("padding-scrub")) {
    await load();
    await page.getByRole("button", { name: "Independent padding", exact: true }).click();
    const start = center(await page.getByRole("button", { name: "Scrub Left", exact: true }).boundingBox());
    await measure("padding-scrub", { frame: "home.html", node: "home-hero", property: "paddingLeft" }, () => drag(start, { x: start.x + 28, y: start.y }));
  }
  await scrub("radius-scrub", "Radius", "borderRadius");
  await scrub("rotation-scrub", "Rotation", "transform");
  if (wants("inline-padding")) {
    await load();
    const start = center(await selected("home-hero").locator('[data-design-inline-spacing="padding-left"]').boundingBox());
    await measure("inline-padding", { frame: "home.html", node: "home-hero", property: "paddingLeft" }, () => drag(start, { x: start.x + 16, y: start.y }));
  }
  if (wants("inline-rotation")) {
    await load();
    const start = center(await selected("home-hero").locator('[data-design-rotate-corner="ne"]').boundingBox());
    await measure("inline-rotation", { frame: "home.html", node: "home-hero", property: "transform" }, () => drag(start, { x: start.x + 24, y: start.y + 24 }));
  }
  for (const kind of ["style", "frame"]) if (wants(`undo-${kind}`) || wants(`redo-${kind}`)) {
    await load(kind === "frame" ? null : "home-hero");
    if (kind === "style") {
      await page.getByLabel("Radius", { exact: true }).fill("24");
      await page.getByLabel("Radius", { exact: true }).press("Enter");
    } else {
      const start = center(await page.locator('[data-design-frame="home.html"] [data-design-frame-label]').boundingBox());
      await drag(start, { x: start.x + 50, y: start.y + 20 });
    }
    await page.waitForFunction(id => !window.__zerosHarnessDesignSurface.measurement.editing(id), workspaceId);
    await nextPaints();
    await page.locator("[data-design-canvas-viewport]").focus();
    const spec = { frame: "home.html", ...(kind === "style" ? { node: "home-hero" } : {}), input: "keydown" };
    if (wants(`undo-${kind}`)) await measure(`undo-${kind}`, spec, () => page.keyboard.press("Control+z"));
    else { await page.keyboard.press("Control+z"); await page.waitForFunction(id => !window.__zerosHarnessDesignSurface.measurement.editing(id), workspaceId); }
    if (wants(`redo-${kind}`)) await measure(`redo-${kind}`, spec, () => page.keyboard.press("Control+Shift+z"));
  }
  if (wants("undo-pending-style")) {
    await load();
    await page.getByLabel("Radius", { exact: true }).fill("24");
    await page.getByLabel("Radius", { exact: true }).press("Enter");
    await page.locator("[data-design-canvas-viewport]").focus();
    await measure("undo-pending-style", { frame: "home.html", node: "home-hero", input: "keydown", pendingEdit: true }, () => page.keyboard.press("Control+z"));
  }
} catch (error) {
  report.errors.push(error.message);
  console.error(error.message);
  if (page) await page.screenshot({ path: resolve(output, "driver-failure.png") }).catch(() => {});
} finally {
  try {
    report.sourceAfter = await identity();
    report.sourceChanged = report.sourceBefore.sourceDigest !== report.sourceAfter.sourceDigest || report.sourceBefore.runnerDigest !== report.sourceAfter.runnerDigest;
    await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2));
  } finally {
    try { await browser?.close(); }
    finally { if (server) await new Promise((done, reject) => server.httpServer.close(error => error ? reject(error) : done())); }
  }
}
if (report.sourceChanged || report.errors.length || report.consoleErrors.length || !report.scenarios.length ||
  report.scenarios.some(scenario => scenario.failure)) process.exitCode = 1;
