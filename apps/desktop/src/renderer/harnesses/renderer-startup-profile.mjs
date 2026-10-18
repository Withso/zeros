// Production browser measurement with the real shell/stores and synthetic
// native replies. Preserve a baseline with --capture=before; --compare=before
// alternates three cold contexts per build. This is not native app launch time.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { build, preview } from "vite";

const capture = process.argv.find(arg => arg.startsWith("--capture="))?.slice(10) ?? "current";
const compare = process.argv.find(arg => arg.startsWith("--compare="))?.slice(10);
for (const label of [capture, compare].filter(Boolean)) assert.match(label, /^[a-z0-9-]+$/);
const entry = "apps/desktop/src/renderer/harnesses/harness-stream-renders.html";
const directory = label => resolve(`.context/renderer-performance/startup-${label}`);
const heavy = /\/features\/simulators\/(?:local-simulator-tab|simulator-annotator|simulator-live-screen|simulator-setup-screen|simulator-device-menu)\.tsx$/;
const reuseBuild = process.argv.includes("--reuse-build");
const metadata = reuseBuild ? JSON.parse(readFileSync(resolve(directory(capture), "measurement.json"), "utf8")) : {};
if (!reuseBuild) await build({ logLevel: "warn", build: { outDir: directory(capture), emptyOutDir: true,
  rollupOptions: { input: resolve(entry) } }, plugins: [{
  name: "startup-module-measurement",
  generateBundle(_options, bundle) {
    const chunks = Object.values(bundle).filter(item => item.type === "chunk");
    const initial = new Set();
    const visit = chunk => {
      if (!chunk || initial.has(chunk)) return;
      initial.add(chunk);
      for (const name of chunk.imports) visit(chunks.find(item => item.fileName === name));
    };
    for (const chunk of chunks.filter(item => item.isEntry)) visit(chunk);
    metadata.initialJsBytes = [...initial].reduce((sum, chunk) => sum + Buffer.byteLength(chunk.code), 0);
    metadata.heavyInitialModules = [...initial].flatMap(chunk => Object.keys(chunk.modules)).filter(id => heavy.test(id));
    metadata.chunks = chunks.map(chunk => ({ file: chunk.fileName, initial: initial.has(chunk), bytes: Buffer.byteLength(chunk.code) }));
  },
}] });
writeFileSync(resolve(directory(capture), "measurement.json"), JSON.stringify(metadata, null, 2));

const servers = new Map();
let browser;
try {
  const labels = compare ? [compare, capture] : [capture];
  for (const label of labels) servers.set(label, await preview({ configFile: false,
    build: { outDir: directory(label) }, preview: { host: "127.0.0.1", port: 0, strictPort: false } }));
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
  const runs = Object.fromEntries(labels.map(label => [label, []]));
  for (let round = 0; round < 3; round++) for (const label of labels) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
    const page = await context.newPage(), errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => {
      let scheduled = false;
      const observe = new globalThis.MutationObserver(() => {
        const editor = globalThis.document.querySelector("[data-chat='stream-A'] [contenteditable='true']");
        if (scheduled || !editor || editor.getBoundingClientRect().height === 0) return;
        scheduled = true; observe.disconnect();
        globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(() => { globalThis.window.composerReadyAt = globalThis.performance.now(); }));
      });
      observe.observe(globalThis.document, { subtree: true, childList: true, attributes: true });
    });
    await page.goto(`${servers.get(label).resolvedUrls.local[0]}${entry}`);
    await page.waitForFunction(() => globalThis.window.composerReadyAt > 0);
    const result = await page.evaluate(() => ({
      composerReadyMs: globalThis.window.composerReadyAt,
      firstPaintMs: globalThis.performance.getEntriesByName("first-contentful-paint")[0]?.startTime,
      switches: [],
    }));
    // Each selection starts in its own task, after the preceding selection
    // painted. Otherwise an async loop resumed inside RAF charges the previous
    // view's deferred layout work to the next navigation.
    for (const id of ["stream-B", "stream-A", "stream-B", "stream-A"]) {
      result.switches.push(await page.evaluate(async id => {
        const start = globalThis.performance.now();
        globalThis.window.streamRenderFixture.select(id);
        const editor = globalThis.document.querySelector(`[data-chat='${id}'] [contenteditable='true']`);
        if (!editor || editor.getBoundingClientRect().height === 0) throw new Error("Selected chat must be interactive in the click task");
        const taskMs = globalThis.performance.now() - start;
        await new Promise(done => globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(done)));
        return { taskMs, paintedMs: globalThis.performance.now() - start };
      }, id));
    }
    assert.deepEqual(errors, []);
    runs[label].push(result);
    await context.close();
  }
  const median = values => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];
  const summary = Object.fromEntries(Object.entries(runs).map(([label, values]) => [label, {
    ...JSON.parse(readFileSync(resolve(directory(label), "measurement.json"), "utf8")),
    composerReadyMs: median(values.map(value => value.composerReadyMs)),
    firstPaintMs: median(values.map(value => value.firstPaintMs)),
    switchTaskMs: median(values.flatMap(value => value.switches.map(item => item.taskMs))),
    switchPaintedMs: median(values.flatMap(value => value.switches.map(item => item.paintedMs))),
  }]));
  console.log(JSON.stringify({ summary, runs }, null, 2));
  writeFileSync(resolve(directory(capture), "timings.json"), JSON.stringify({ summary, runs }, null, 2));
  if (process.argv.includes("--assert-split")) assert.deepEqual(metadata.heavyInitialModules, [], "unused Local simulator implementation must stay outside startup chunks");
} finally {
  await browser?.close();
  for (const server of servers.values()) await new Promise(done => server.httpServer.close(done));
}
