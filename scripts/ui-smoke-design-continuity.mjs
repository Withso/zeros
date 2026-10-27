#!/usr/bin/env node
// Diagnostic evidence, deliberately outside CI timing assertions. Uses the
// real renderer/runtime with an opt-in delayed fixture engine. rAF observes DOM
// readiness; it does not establish compositor presentation or native latency.
// Start Vite on the chosen port, then:
// node scripts/ui-smoke-design-continuity.mjs --base-url http://127.0.0.1:5299
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "@playwright/test";
import { designCanvasPoint, designFrameElementBox } from "./ui-smoke-design-helpers.mjs";
import { installDesignAttributionProbe, mapDesignAttributionSources, summarizeDesignAttribution } from "./ui-smoke-design-attribution.mjs";

const { values } = parseArgs({ options: {
  "base-url": { type: "string", default: "http://127.0.0.1:5299" },
  out: { type: "string", default: ".context/measure/design-continuity" },
  delay: { type: "string", default: "400" },
  only: { type: "string" },
  production: { type: "boolean", default: false },
  profile: { type: "boolean", default: false },
  attribute: { type: "boolean", default: false },
  retained: { type: "boolean", default: false },
} });
if (values.attribute) values.profile = true;
const output = resolve(values.out);
await mkdir(output, { recursive: true });
const wants = name => !values.only || values.only.split(",").some(pattern => name.includes(pattern));
const sourceIdentity = async () => {
  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--",
    "apps/desktop/src", "packages/protocol/src", "packages/design-core/src", "packages/design-web/src",
    "styles", "vite.config.ts", "package.json", "pnpm-lock.yaml"], { encoding: "utf8" }).split("\0").filter(Boolean).sort();
  const source = createHash("sha256");
  for (const file of files) source.update(file).update("\0").update(await readFile(file)).update("\0");
  return {
    revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    sourceDigest: source.digest("hex"),
    runnerDigest: createHash("sha256").update(await readFile(new URL(import.meta.url)))
      .update(await readFile(new URL("./ui-smoke-design-attribution.mjs", import.meta.url))).digest("hex"),
  };
};
const buildSource = await sourceIdentity();
let staticServer, browser, page;
const report = {
  recordedAt: new Date().toISOString(), browser: null,
  viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1,
  engineDelayMs: Math.max(0, Math.min(500, Number.isFinite(Number(values.delay)) ? Number(values.delay) : 400)),
  build: values.production ? "production" : "development", profiling: values.profile, attribution: values.attribute, buildSource,
  evidence: "rAF DOM observations in Playwright Chromium; not native presentation, CPU or GPU qualification",
  fixture: "Loopback srcdoc fixture; packaged Electron CSP omitted from the emitted harness HTML only",
  ownerFixture: "Personal and organization Local identities with separate checkout/cache keys; no cloud Design capability",
  surfaceFixture: values.retained ? "Production RetainedDesignDeck (two bounded surfaces)" : "Single DesignWorkspaceColumn (owner replacement/remount)",
  sourceBefore: buildSource,
  scenarios: [], errors: [], consoleErrors: [],
};
async function start() {
if (values.production) {
  const origin = new URL(values["base-url"]);
  if (!["127.0.0.1", "localhost"].includes(origin.hostname)) throw new Error("The production fixture server binds only to loopback.");
  const { build, preview } = await import("vite");
  const outDir = resolve(output, "build");
  await build({ configFile: resolve("vite.config.ts"), mode: "ui-smoke", logLevel: "warn",
    define: { "process.env.NODE_ENV": '"production"' },
    ...(values.profile ? { resolve: { alias: [{ find: /^react-dom$/, replacement: "react-dom/profiling" }] }, esbuild: { keepNames: true } } : {}),
    build: { outDir, emptyOutDir: true, sourcemap: values.attribute, rollupOptions: { input: resolve("apps/desktop/src/renderer/harnesses/harness-design-workspace.html") } },
  });
  // Native Design uses its isolated protocol. This browser-only fixture uses
  // inline srcdoc runtimes, like its development entry; inheriting Electron's
  // packaged CSP prevents those runtimes from starting. Change only this
  // emitted harness HTML, never the product CSP or its build configuration.
  const htmlPath = resolve(outDir, "apps/desktop/src/renderer/harnesses/harness-design-workspace.html");
  const html = await readFile(htmlPath, "utf8");
  const fixtureHtml = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, "");
  if (fixtureHtml === html) throw new Error("Expected the packaged CSP in the emitted harness HTML.");
  await writeFile(htmlPath, fixtureHtml);
  staticServer = await preview({ configFile: resolve("vite.config.ts"), mode: "ui-smoke", logLevel: "warn", build: { outDir },
    preview: { host: "127.0.0.1", port: Number(origin.port || 5299), strictPort: true } });
}
browser = await chromium.launch();
report.browser = browser.version();
page = await browser.newPage({ viewport: report.viewport, deviceScaleFactor: 1 });
if (values.attribute) await page.addInitScript(installDesignAttributionProbe);
if (values.profile) await page.addInitScript(() => {
  if (window !== window.top) return;
  const renderers = new Map();
  const commits = [];
  const lastRenderStarts = new WeakMap();
  window.__zerosDesignFiberCommits = commits;
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true, renderers,
    inject(renderer) {
      const id = renderers.size + 1;
      renderers.set(id, renderer);
      window.__zerosDesignAttribution?.inject(renderer);
      return id;
    },
    checkDCE() {}, onCommitFiberUnmount() {},
    onCommitFiberRoot(_id, root) {
      const attribution = window.__zerosDesignAttribution?.commit(root);
      const recording = window.__zerosDesignContinuityProbe?.recording();
      const components = [];
      const visit = (fiber, inside = false) => {
        inside ||= fiber.tag === 12 && fiber.memoizedProps?.id === "DesignWorkspaceColumn";
        // A bailed-out subtree can retain both PerformedWork and profiling
        // durations. Track each fiber/alternate's render start, even outside a
        // recording, so an unchanged component is never charged repeatedly.
        const fresh = fiber.actualStartTime !== lastRenderStarts.get(fiber) &&
          (!fiber.alternate || fiber.actualStartTime !== lastRenderStarts.get(fiber.alternate));
        lastRenderStarts.set(fiber, fiber.actualStartTime);
        if (recording && inside && fresh && (fiber.flags & 1) && fiber.actualDuration > 0 && [0, 1, 11, 14, 15].includes(fiber.tag)) {
          const type = fiber.type?.render ?? fiber.type?.type ?? fiber.type;
          const name = fiber.type?.displayName || type?.displayName || type?.name || "Anonymous";
          let childrenMs = 0;
          for (let child = fiber.child; child; child = child.sibling) childrenMs += child.actualDuration ?? 0;
          components.push({ name, renderMs: fiber.actualDuration, selfMs: Math.max(0, fiber.actualDuration - childrenMs) });
        }
        for (let child = fiber.child; child; child = child.sibling) visit(child, inside);
      };
      visit(root.current);
      if (recording) commits.push({ at: performance.now(), components, ...(attribution ? { attribution } : {}) });
      if (commits.length > 512) commits.shift();
    },
  };
});
page.setDefaultTimeout(15_000);
page.on("pageerror", error => report.errors.push(error.message));
page.on("console", message => {
  if (message.type() === "error" && report.consoleErrors.length < 64) report.consoleErrors.push(message.text());
});
}
const workspaceId = "ws_design_harness";
const organizationId = "organization-local";

async function installSampler() {
  await page.evaluate(() => {
    let request = null, current = null;
    const controls = () => window.__zerosHarnessDesignSurface;
    const visible = element => {
      if (!element || !element.getBoundingClientRect().width || !element.getBoundingClientRect().height) return false;
      for (let node = element; node instanceof Element; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
      }
      return true;
    };
    const read = (spec = {}) => {
      const c = controls();
      const host = document.querySelector("[data-harness-design-owner]");
      const owner = host?.getAttribute("data-harness-design-owner");
      const root = host?.querySelector(`[data-design-retained-workspace="${CSS.escape(owner)}"]`) ?? host;
      const view = c.ui.getState().byWorkspace[owner];
      const read = c.snapshots.peekSnapshot(owner);
      const inspector = root?.querySelector("[data-design-inspector]");
      const layers = root?.querySelector('[aria-label="Design layers"]');
      const fields = Object.fromEntries([...inspector?.querySelectorAll("input[aria-label]") ?? []]
        .filter(input => input.type !== "checkbox").map(input => [input.getAttribute("aria-label"), input.value]));
      const selectedRows = [...layers?.querySelectorAll('[aria-selected="true"]') ?? []]
        .map(row => ({ frame: row.getAttribute("data-design-frame-row"), node: row.getAttribute("data-design-layer-id") }));
      const file = spec.frame ?? view?.selectedFrame;
      const frame = file ? root?.querySelector(`[data-design-frame="${CSS.escape(file)}"]`) : null;
      const representation = frame ? [...frame.querySelectorAll("[data-design-document-ready], [data-design-source-ready], img[data-design-frame-picture], img[data-design-frame-screenshot], img[data-design-frame-transition-cover]")]
        .filter(element => visible(element) && (!(element instanceof HTMLImageElement) || element.complete && element.naturalWidth > 0)) : [];
      const draft = root?.querySelector("[data-design-creation-draft]");
      const runtime = file ? c.measurement.runtime.getState().byWorkspace[owner]?.frames[file] : null;
      const snapshotFrame = read.data?.frames.find(frame => frame.file === file);
      const active = host?.getAttribute("data-harness-design-active") !== "false";
      const layerCount = layers?.querySelectorAll('[role="treeitem"]').length ?? 0;
      const hasSelection = Boolean(view?.frameSelected || view?.selectedNodeId);
      const canvasBlank = active && Boolean(file) && !representation.length && !(spec.creation && visible(draft));
      const blankBuffers = canvasBlank && frame ? [...frame.querySelectorAll("iframe, img, [data-design-source-ready]")].slice(0, 8).map(element => {
        let hiddenBy = null;
        for (let node = element; node instanceof Element; node = node.parentElement) {
          const style = getComputedStyle(node);
          if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
            hiddenBy = { tag: node.tagName, className: node.className, display: style.display, visibility: style.visibility, opacity: style.opacity };
            break;
          }
        }
        return { tag: element.tagName, data: { ...element.dataset }, hiddenBy,
          width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height,
          ...(element instanceof HTMLImageElement ? { complete: element.complete, naturalWidth: element.naturalWidth } : {}) };
      }) : [];
      return {
        owner, active, frame: view?.selectedFrame ?? null, node: view?.selectedNodeId ?? null,
        cacheOwnerPath: read.data?.lint.workspacePath ?? null,
        runtimeOwnerPath: c.measurement.runtime.getState().byWorkspace[owner]?.folder ?? null,
        retainedSurfaces: host?.querySelectorAll("[data-design-retained-workspace]").length ?? 0,
        frameSelected: view?.frameSelected ?? false,
        inspectorHeader: inspector?.querySelector("[data-design-inspector-header]")?.textContent?.trim() ?? "",
        fields, selectedRows, layerCount,
        pendingLayers: /Loading frame|Preparing frame/i.test(layers?.textContent ?? ""),
        layersHidden: active && Boolean(file) && !visible(layers),
        inspectorHidden: active && hasSelection && !visible(inspector),
        inspectorHeld: Boolean(root?.querySelector('[data-design-inspector-presentation="held"]')),
        layersEmpty: active && Boolean(file) && layerCount === 0,
        selectionMissingFromLayers: hasSelection && !selectedRows.some(row => view.selectedNodeId ? row.node === view.selectedNodeId : row.frame === view.selectedFrame),
        nothingSelected: /Nothing selected/.test(inspector?.textContent ?? ""),
        inspectorEmpty: hasSelection && Object.keys(fields).length === 0,
        inspectorIncomplete: hasSelection && !Object.hasOwn(fields, "Rotation"),
        canvasBlank, blankBuffers,
        draftVisible: visible(draft),
        representations: representation.map(element => element.tagName === "IFRAME" ? "document" : "picture"),
        frameVersion: snapshotFrame?.sourceVersion ?? null, runtimeVersion: runtime?.sourceVersion ?? null,
        refreshing: read.refreshing || read.loading, editing: c.measurement.editing(owner),
        enginePending: c.measurement.requests.some(request => request.workspaceId === owner && request.released === null),
        error: read.error?.message ?? null,
      };
    };
    const matches = (sample, spec) => sample.active && !sample.refreshing && !sample.editing && !sample.enginePending && !sample.error &&
      !sample.pendingLayers && !sample.layersHidden && !sample.inspectorHidden && !sample.inspectorHeld && !sample.nothingSelected && !sample.inspectorIncomplete && !sample.canvasBlank &&
      (!spec.owner || sample.owner === spec.owner) && (!spec.frame || sample.frame === spec.frame) &&
      (!spec.node || sample.node === spec.node) &&
      (!spec.newNode || Boolean(sample.node) && sample.node !== spec.previousNode) &&
      (!spec.field || sample.fields[spec.field] === spec.value) &&
      (!spec.previousVersion || sample.frameVersion !== spec.previousVersion) &&
      sample.frameVersion === sample.runtimeVersion &&
      sample.selectedRows.some(row => sample.node ? row.node === sample.node : row.frame === sample.frame);
    const tick = () => {
      if (!current) return;
      const value = read(current.spec);
      current.samples.push({ ms: performance.now() - current.started, ...value, final: matches(value, current.spec) });
      if (current.samples.length < 2400) request = requestAnimationFrame(tick);
      else current.truncated = true;
    };
    const mark = () => { if (current && current.inputAt === null) current.inputAt = performance.now(); };
    for (const type of ["pointerdown", "pointerup", "pointermove", "keydown"]) document.addEventListener(type, event => {
      if (current?.spec.input === type && (type !== "keydown" || event.key === "Enter")) mark();
    }, true);
    window.__zerosDesignContinuityProbe = {
      read, matches, mark, recording: () => current !== null,
      start(spec) {
        if (request !== null) cancelAnimationFrame(request);
        window.__zerosDesignAttribution?.reset();
        current = { started: performance.now(), inputAt: null, spec, samples: [], truncated: false, resourcesBefore: controls().resources() };
        request = requestAnimationFrame(tick);
      },
      ready() { return current && matches(read(current.spec), current.spec) &&
        current.samples.length >= 3 && current.samples.slice(-3).every(sample => sample.final); },
      elapsedSinceInput() { return current ? performance.now() - (current.inputAt ?? current.started) : 0; },
      stop() {
        if (request !== null) cancelAnimationFrame(request);
        request = null;
        const result = { ...current, timeOrigin: performance.timeOrigin, elapsedMs: performance.now() - current.started, resourcesAfter: controls().resources(),
          commits: controls().measurement.commits.filter(commit => commit.commitTime >= current.started),
          fiberCommits: (window.__zerosDesignFiberCommits ?? []).filter(commit => commit.at >= current.started),
          attribution: window.__zerosDesignAttribution?.snapshot() ?? null,
          runtimeReads: window.__zerosContinuityHeldDetails?.records ?? [],
          requests: controls().measurement.requests.filter(request => request.started >= current.started || request.released === null || request.released >= current.started)
            .map(request => ({ ...request, startedMs: request.started - current.started, releasedMs: request.released === null ? null : request.released - current.started })) };
        current = null;
        return result;
      },
    };
  });
}

async function watchStyles(file) {
  const frame = await (await selectedFrame(file).locator("iframe[data-design-document-ready]").first().elementHandle()).contentFrame();
  const oid = await page.evaluate(file => {
    const c = window.__zerosHarnessDesignSurface;
    const owner = document.querySelector("[data-harness-design-owner]").getAttribute("data-harness-design-owner");
    return c.ui.getState().byWorkspace[owner]?.selectedNodeId ?? c.measurement.runtime.getState().byWorkspace[owner]?.frames[file]?.snapshot?.frame.oid;
  }, file);
  await frame.evaluate(oid => {
    const data = { samples: [], request: 0 };
    const sample = () => {
      const element = document.querySelector(`[data-oid="${CSS.escape(oid)}"]`);
      const style = element && getComputedStyle(element);
      data.samples.push({ epochMs: performance.timeOrigin + performance.now(), present: Boolean(element),
        paddingLeft: style?.paddingLeft, radius: style?.borderTopLeftRadius, rotate: style?.rotate,
        transform: style?.transform, fill: style?.backgroundColor });
      if (data.samples.length < 2400) data.request = requestAnimationFrame(sample);
    };
    data.request = requestAnimationFrame(sample);
    window.__zerosContinuityStyleEvidence = data;
  }, oid);
  return async () => frame.evaluate(() => {
    const data = window.__zerosContinuityStyleEvidence;
    if (!data) return { runtimeReplaced: true, samples: [] };
    cancelAnimationFrame(data.request);
    delete window.__zerosContinuityStyleEvidence;
    return { runtimeReplaced: false, samples: data.samples };
  }).catch(() => ({ runtimeReplaced: true, samples: [] }));
}

async function watchInsertedNodes(file) {
  const frame = await (await selectedFrame(file).locator("iframe[data-design-document-ready]").first().elementHandle()).contentFrame();
  await frame.evaluate(() => {
    const before = new Set([...document.querySelectorAll("[data-oid]")].map(node => node.getAttribute("data-oid")));
    const data = { samples: [], request: 0 };
    const sample = () => {
      data.samples.push({ epochMs: performance.timeOrigin + performance.now(),
        nodeIds: [...document.querySelectorAll("[data-oid]")].map(node => node.getAttribute("data-oid")).filter(id => !before.has(id)) });
      if (data.samples.length < 2400) data.request = requestAnimationFrame(sample);
    };
    data.request = requestAnimationFrame(sample);
    window.__zerosContinuityInsertionEvidence = data;
  });
  return async () => frame.evaluate(() => {
    const data = window.__zerosContinuityInsertionEvidence;
    if (!data) return { runtimeReplaced: true, samples: [] };
    cancelAnimationFrame(data.request);
    delete window.__zerosContinuityInsertionEvidence;
    return { runtimeReplaced: false, samples: data.samples };
  }).catch(() => ({ runtimeReplaced: true, samples: [] }));
}

const nextPaints = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const activeSurface = () => page.locator("[data-design-workspace-surface]:visible");
const selectedFrame = file => activeSurface().locator(`[data-design-frame="${file}"]`);
const frameRow = file => activeSurface().locator(`[data-design-frame-row="${file}"]`);
async function settleFrame(file) {
  await frameRow(file).click();
  await selectedFrame(file).locator("iframe[data-design-document-ready]").first().waitFor();
  await activeSurface().getByLabel("Rotation", { exact: true }).waitFor();
  await nextPaints();
}
async function measure(name, spec, action, completed) {
  if (!wants(name)) return;
  const stopStyles = spec.styles ? await watchStyles(spec.frame) : null;
  const stopInsertions = spec.newNode ? await watchInsertedNodes(spec.frame) : null;
  await page.evaluate(spec => window.__zerosDesignContinuityProbe.start(spec), spec);
  let failure;
  try {
    if (!spec.input) await page.evaluate(() => window.__zerosDesignContinuityProbe.mark());
    await action();
    if (completed) await completed();
    await page.waitForFunction(() => window.__zerosDesignContinuityProbe.ready());
    // Observe deferred runtime/cover retirement after first readiness. Profile
    // runs also include a complete first 600 ms from the actual input event.
    const elapsed = await page.evaluate(() => window.__zerosDesignContinuityProbe.elapsedSinceInput());
    await page.waitForTimeout(Math.max(250, values.profile ? 600 - elapsed : 0));
    await nextPaints();
    await page.waitForFunction(() => window.__zerosDesignContinuityProbe.ready());
  } catch (error) { failure = error.message; }
  const result = await page.evaluate(() => window.__zerosDesignContinuityProbe.stop());
  if (values.attribute && values.production) await mapDesignAttributionSources(result, resolve(output, "build"));
  if (stopStyles) result.computedStyles = await stopStyles();
  if (stopInsertions) {
    result.insertions = await stopInsertions();
    const nodeId = result.samples.findLast(sample => sample.node && sample.node !== spec.previousNode)?.node;
    const firstPresent = result.insertions.samples.findIndex(sample => sample.nodeIds.includes(nodeId));
    result.insertions.nodeId = nodeId;
    result.insertions.firstPresentMs = firstPresent < 0 ? null : result.insertions.samples[firstPresent].epochMs - result.timeOrigin - result.inputAt;
    result.insertions.missingAfterFirstCount = firstPresent < 0 ? null : result.insertions.samples.slice(firstPresent).filter(sample => !sample.nodeIds.includes(nodeId)).length;
  }
  const inputOffset = result.inputAt === null ? null : result.inputAt - result.started;
  const samples = result.samples.filter(sample => sample.active && inputOffset !== null && sample.ms >= inputOffset)
    .map(sample => ({ ...sample, ms: sample.ms - inputOffset }));
  const lastUnready = samples.findLastIndex(sample => !sample.final);
  const flags = ["pendingLayers", "layersHidden", "layersEmpty", "selectionMissingFromLayers", "nothingSelected", "inspectorHidden", "inspectorHeld", "inspectorEmpty", "inspectorIncomplete", "canvasBlank"];
  const summary = Object.fromEntries(flags.map(key => [key, {
    count: samples.filter(sample => sample[key]).length,
    firstMs: samples.find(sample => sample[key])?.ms ?? null,
    lastMs: samples.findLast(sample => sample[key])?.ms ?? null,
  }]));
  const entry = { name, failure: failure ?? null, sampleCount: samples.length,
    inputOffsetMs: inputOffset,
    firstFinalMs: samples.find(sample => sample.final)?.ms ?? null,
    stableFinalMs: samples[lastUnready + 1]?.ms ?? null, ...summary, ...result };
  if (!entry.failure && entry.stableFinalMs === null) entry.failure = "Recording ended without a stable final rAF observation.";
  const componentTimes = new Map();
  for (const commit of result.fiberCommits.filter(commit => commit.at >= (result.inputAt ?? result.started))) for (const component of commit.components) {
    const total = componentTimes.get(component.name) ?? { name: component.name, renders: 0, selfMs: 0, renderMs: 0 };
    total.renders++; total.selfMs += component.selfMs; total.renderMs += component.renderMs;
    componentTimes.set(component.name, total);
  }
  const interactionCommits = result.commits.filter(commit => commit.commitTime >= (result.inputAt ?? result.started));
  const renderWindow = milliseconds => {
    const commits = interactionCommits.filter(commit => commit.commitTime - (result.inputAt ?? result.started) <= milliseconds);
    return { commitCount: commits.length, renderMs: commits.reduce((sum, commit) => sum + commit.actualDuration, 0) };
  };
  entry.react = { commitCount: interactionCommits.length,
    totalRenderMs: interactionCommits.reduce((sum, commit) => sum + commit.actualDuration, 0),
    maxRenderMs: Math.max(0, ...interactionCommits.map(commit => commit.actualDuration)),
    topComponents: [...componentTimes.values()].sort((a, b) => b.selfMs - a.selfMs).slice(0, 12),
    first100ms: renderWindow(100), first600ms: renderWindow(600),
    note: "Profiler actualDuration is render work per commit, not DOM commit wall time; component self times are estimates from profiling fibers.",
  };
  entry.attributionSummary = summarizeDesignAttribution(result);
  if (values.attribute && (!entry.attributionSummary?.hooksInstalled || entry.attributionSummary.dropped)) {
    entry.failure ??= "Incomplete attribution: missing React scheduling hooks or a truncated trace.";
  }
  report.scenarios.push(entry);
  await writeFile(resolve(output, `${name}.json`), JSON.stringify(entry, null, 2));
  await page.screenshot({ path: resolve(output, `${name}.png`) });
  await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ name, failure: entry.failure, samples: entry.sampleCount, stableFinalMs: entry.stableFinalMs,
    ...Object.fromEntries(flags.map(key => [key, entry[key].count])) }));
}

async function styleEdit(name, label, value) {
  if (!wants(name)) return;
  await settleFrame("home.html");
  const input = page.getByLabel(label, { exact: true });
  await input.fill(value);
  const before = await page.evaluate(() => window.__zerosDesignContinuityProbe.read().frameVersion);
  await measure(name, { owner: workspaceId, frame: "home.html", field: label, value, input: "keydown", previousVersion: before, styles: true },
    () => input.press("Enter"),
    () => page.waitForFunction(before => window.__zerosDesignContinuityProbe.read().frameVersion !== before, before));
}

async function resetRotation() {
  await settleFrame("home.html");
  const input = page.getByLabel("Rotation", { exact: true });
  if (await input.inputValue() === "0") return;
  const before = await page.evaluate(() => window.__zerosDesignContinuityProbe.read().frameVersion);
  await input.fill("0");
  await input.press("Enter");
  await page.waitForFunction(before => {
    const sample = window.__zerosDesignContinuityProbe.read();
    return sample.frameVersion !== before && sample.frameVersion === sample.runtimeVersion && !sample.editing;
  }, before);
}

async function startNestedDraw() {
  const nestedFrame = selectedFrame("home.html");
  const iframe = nestedFrame.locator("iframe[data-design-document-ready]").first();
  const parent = nestedFrame.frameLocator("iframe[data-design-document-ready]").locator('[data-oid="home-main"]');
  const box = await designFrameElementBox(iframe, parent);
  const start = { x: box.x + box.width * 0.6, y: box.y + box.height * 0.55 };
  const previousNode = await page.evaluate(() => window.__zerosDesignContinuityProbe.read().node);
  await page.locator("[data-design-canvas-viewport]").focus();
  await page.keyboard.press("f");
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 45, start.y + 35, { steps: 4 });
  return { owner: workspaceId, frame: "home.html", creation: true, newNode: true, previousNode, input: "pointerup" };
}

try {
  await start();
  const url = new URL("/apps/desktop/src/renderer/harnesses/harness-design-workspace.html", values["base-url"]);
  url.searchParams.set("measureContinuity", "1");
  url.searchParams.set("engineDelayMs", String(report.engineDelayMs));
  if (values.profile) url.searchParams.set("profileContinuity", "1");
  if (values.attribute) url.searchParams.set("attributeContinuity", "1");
  if (values.retained) url.searchParams.set("retainedContinuity", "1");
  await page.goto(url.href, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__zerosHarnessDesignSurface?.measurement);
  await installSampler();
  await settleFrame("home.html");
  if (values.attribute) await page.waitForTimeout(500);

  for (const [index, file] of ["pricing.html", "home.html", "pricing.html", "home.html"].entries()) {
    await measure(`select-${index + 1}-${file.replace(".html", "")}`, { owner: workspaceId, frame: file, input: "pointerdown" }, () => frameRow(file).click());
  }
  if (wants("select-label-pricing")) {
    await settleFrame("home.html");
    await measure("select-label-pricing", { owner: workspaceId, frame: "pricing.html", input: "pointerdown" },
      () => selectedFrame("pricing.html").locator("[data-design-frame-label]").click());
  }
  if (wants("hover-layers")) {
    await settleFrame("home.html");
    if (await frameRow("home.html").getAttribute("aria-expanded") === "false")
      await frameRow("home.html").locator("[data-layer-disclosure]").click();
    for (let attempt = 0; attempt < 8 && await activeSurface().locator("[data-design-layer-id]:visible").count() < 10; attempt++) {
      const folded = activeSurface().locator('[data-design-layer-id][aria-expanded="false"]:visible').first();
      if (!await folded.count()) break;
      await folded.locator("[data-layer-disclosure]").click();
    }
    const targets = await activeSurface().locator("[data-design-layer-id]:visible").evaluateAll(rows =>
      rows.slice(0, 10).map(row => row.getAttribute("data-design-layer-id")));
    if (targets.length !== 10) throw new Error("The hover sweep requires ten visible Layers rows.");
    await page.mouse.move(700, 80);
    await page.waitForTimeout(350);
    await measure("hover-layers", { owner: workspaceId, frame: "home.html", input: "pointermove", hoverTargets: targets, dwellMs: 35 }, async () => {
      for (const node of targets) {
        await activeSurface().locator(`[data-design-layer-id="${node}"]`).hover();
        await page.waitForTimeout(35);
      }
    });
  }
  if (wants("select-layer")) {
    await settleFrame("home.html");
    if (!await page.locator("[data-design-layer-id]:visible").count()) await frameRow("home.html").locator("[data-layer-disclosure]").click();
    const layer = page.locator("[data-design-layer-id]:visible").first();
    const node = await layer.getAttribute("data-design-layer-id");
    await measure("select-layer", { owner: workspaceId, frame: "home.html", node, input: "pointerdown" }, () => layer.click());
  }
  if (wants("select-cold-layer")) {
    await settleFrame("home.html");
    if (!await activeSurface().locator("[data-design-layer-id]:visible").count()) await frameRow("home.html").locator("[data-layer-disclosure]").click();
    const node = await activeSurface().locator("[data-design-layer-id]:visible").evaluateAll(rows => {
      const cached = window.__zerosHarnessDesignSurface.measurement.runtime.getState().byWorkspace.ws_design_harness?.frames["home.html"]?.detailsByNode ?? {};
      return rows.map(row => row.getAttribute("data-design-layer-id")).find(id => id?.startsWith("home-") && !cached[id]);
    });
    if (!node) throw new Error("The cold-layer scenario needs an uncached visible fixture node.");
    await page.evaluate(node => {
      const original = MessagePort.prototype.postMessage;
      const queued = [], records = [];
      MessagePort.prototype.postMessage = function(message, ...rest) {
        if (message?.method !== "getNodeDetails" || message.args?.nodeId !== node) return original.call(this, message, ...rest);
        if (queued.length >= 32) throw new Error("Held fixture runtime read budget exceeded.");
        const record = { nodeId: node, sourceVersion: message.sourceVersion, started: performance.now(), released: null };
        records.push(record);
        queued.push(() => { record.released = performance.now(); original.call(this, message, ...rest); });
      };
      window.__zerosContinuityHeldDetails = { records, release() {
        MessagePort.prototype.postMessage = original;
        for (const send of queued.splice(0)) send();
      } };
    }, node);
    try {
      await measure("select-cold-layer", { owner: workspaceId, frame: "home.html", node, input: "pointerdown", runtimeDetailHoldMs: 400 }, async () => {
        try {
          await activeSurface().locator(`[data-design-layer-id="${node}"]`).click();
          await page.waitForFunction(() => window.__zerosContinuityHeldDetails.records.length > 0);
          await page.waitForTimeout(400);
        } finally { await page.evaluate(() => window.__zerosContinuityHeldDetails.release()); }
      });
    } finally {
      await page.evaluate(() => { window.__zerosContinuityHeldDetails.release(); delete window.__zerosContinuityHeldDetails; });
    }
  }
  await styleEdit("style-padding", "Horizontal", "84");
  await styleEdit("style-radius", "Radius", "24");
  await styleEdit("style-rotation", "Rotation", "15");

  if (wants("style-fill")) {
    await settleFrame("home.html");
    const fill = page.getByLabel("Edit fill", { exact: true });
    if (!await fill.count()) {
      await page.getByLabel("Add fill", { exact: true }).click();
      await page.waitForFunction(() => !window.__zerosHarnessDesignSurface.measurement.editing("ws_design_harness"));
    }
    await fill.click();
    const color = page.getByLabel("Fill", { exact: true });
    await color.fill("#336699");
    const before = await page.evaluate(() => window.__zerosDesignContinuityProbe.read().frameVersion);
    await measure("style-fill", { owner: workspaceId, frame: "home.html", input: "keydown", previousVersion: before, styles: true },
      () => color.press("Enter"),
      () => page.waitForFunction(before => window.__zerosDesignContinuityProbe.read().frameVersion !== before, before));
    await page.keyboard.press("Escape");
  }

  // Separate ordinary nested creation from the explicit pending-style race.
  if (wants("create-nested")) {
    await resetRotation();
    const spec = await startNestedDraw();
    await measure("create-nested", spec, () => page.mouse.up());
  }
  if (wants("style-then-create-nested")) {
    await resetRotation();
    await page.evaluate(() => window.__zerosHarnessDesignSurface.measurement.hold("design.node.styles"));
    try {
      await page.getByLabel("Radius", { exact: true }).fill("32");
      await page.getByLabel("Radius", { exact: true }).press("Enter");
      await page.waitForFunction(() => window.__zerosHarnessDesignSurface.measurement.editing("ws_design_harness"));
      const spec = await startNestedDraw();
      await measure("style-then-create-nested", spec, async () => {
        try {
          await page.mouse.up();
          await page.waitForFunction(previous => {
            const node = window.__zerosDesignContinuityProbe.read().node;
            return node && node !== previous;
          }, spec.previousNode);
        } finally {
          await page.evaluate(() => window.__zerosHarnessDesignSurface.measurement.release("design.node.styles"));
        }
      });
    } finally {
      await page.evaluate(() => window.__zerosHarnessDesignSurface.measurement.release("design.node.styles"));
    }
  }

  if (wants("create-frame")) {
    await page.locator("[data-design-canvas-viewport]").focus();
    const empty = await designCanvasPoint(page, { empty: true });
    await page.keyboard.press("f");
    await page.mouse.move(empty.x, empty.y);
    await page.mouse.down();
    await page.mouse.move(empty.x + 65, empty.y + 45, { steps: 4 });
    await measure("create-frame", { owner: workspaceId, frame: "frame-1.html", creation: true, input: "pointerup" }, () => page.mouse.up());
  }

  await settleFrame("home.html");
  await measure("warm-revalidation", { owner: workspaceId, frame: "home.html" },
    () => page.evaluate(id => window.__zerosHarnessDesignSurface.measurement.refresh(id), workspaceId));

  if (wants("hidden-retirement-return")) {
    await page.evaluate(() => window.__zerosDesignHarnessRuntime.flushSync(() => window.__zerosHarnessDesignSurface.active(false)));
    await page.waitForTimeout(11_000);
    report.hiddenResources = await page.evaluate(() => window.__zerosHarnessDesignSurface.resources());
    await measure("hidden-retirement-return", { owner: workspaceId, frame: "home.html" },
      () => page.evaluate(() => window.__zerosDesignHarnessRuntime.flushSync(() => window.__zerosHarnessDesignSurface.active(true))));
  }

  if (!values.only || values.only.split(",").some(pattern => pattern.includes("owner"))) {
    await page.evaluate(id => window.__zerosDesignHarnessRuntime.flushSync(() => window.__zerosHarnessDesignSurface.owner(id)), organizationId);
    await settleFrame("pricing.html");
    await measure("owner-personal-return", { owner: workspaceId, frame: "home.html" },
      () => page.evaluate(id => window.__zerosDesignHarnessRuntime.flushSync(() => window.__zerosHarnessDesignSurface.owner(id)), workspaceId));
    await measure("owner-organization-return", { owner: organizationId, frame: "pricing.html" },
      () => page.evaluate(id => window.__zerosDesignHarnessRuntime.flushSync(() => window.__zerosHarnessDesignSurface.owner(id)), organizationId));
    await measure("owner-personal-return-again", { owner: workspaceId, frame: "home.html" },
      () => page.evaluate(id => window.__zerosDesignHarnessRuntime.flushSync(() => window.__zerosHarnessDesignSurface.owner(id)), workspaceId));
  }
} catch (error) {
  report.errors.push(error.message);
  console.error(error.message);
  if (page) await page.screenshot({ path: resolve(output, "driver-failure.png") }).catch(() => {});
} finally {
  try {
    report.sourceAfter = await sourceIdentity();
    report.sourceChanged = report.sourceBefore.sourceDigest !== report.sourceAfter.sourceDigest ||
      report.sourceBefore.runnerDigest !== report.sourceAfter.runnerDigest;
    await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2));
  } finally {
    try { await browser?.close(); }
    finally { if (staticServer) await new Promise((resolve, reject) => staticServer.httpServer.close(error => error ? reject(error) : resolve())); }
  }
}
// Only incomplete evidence/driver errors fail. A measured glitch is a finding,
// not a noisy CI timing assertion; all raw observations remain in the report.
if (report.errors.length || report.scenarios.some(scenario => scenario.failure)) process.exitCode = 1;
