// Hold the Local code chunk to prove the native snapshot starts in parallel,
// then prove pointer intent makes a new tab ready in its selection task.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { build, preview } from "vite";

const entry = "apps/desktop/src/renderer/harnesses/harness-simulator-tab.html";
const outDir = resolve(".context/renderer-performance/simulator-loading-dist");
const localChunk = /\/local-simulator-tab-[^/]+\.js(?:\?|$)/;
let server, browser, releaseChunk;
try {
  await build({ logLevel: "warn", build: { outDir, emptyOutDir: true, rollupOptions: { input: resolve(entry) } } });
  server = await preview({ configFile: false, build: { outDir }, preview: { host: "127.0.0.1", port: 0, strictPort: false } });
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
  const errors = [], results = {};
  const open = async query => {
    const context = await browser.newContext({ viewport: { width: 1100, height: 800 }, reducedMotion: "reduce" });
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${server.resolvedUrls.local[0]}${entry}?intent&${query}`);
    await page.waitForFunction(() => !!globalThis.window.simulatorFixture);
    return page;
  };
  const cold = await open("");
  let chunkRequested = false;
  const held = new Promise(resolveHeld => { releaseChunk = resolveHeld; });
  await cold.route(localChunk, async route => { chunkRequested = true; await held; await route.continue(); });
  await cold.evaluate(() => globalThis.window.simulatorFixture.openNow());
  await cold.waitForFunction(() => globalThis.window.simulatorFixture.calls.includes("simulator_hub_state"), undefined, { timeout: 3_000 });
  assert.equal(chunkRequested, true, "the native read must start while the Local chunk is held");
  results.nativeReadBeforeChunk = true;
  releaseChunk();
  await cold.locator("[data-simulator-setup-screen]").waitFor();
  await cold.evaluate(() => { globalThis.window.simulatorSetupElement = globalThis.document.querySelector("[data-simulator-setup-screen]"); globalThis.window.simulatorFixture.setActive(false); });
  await cold.evaluate(() => new Promise(globalThis.requestAnimationFrame));
  await cold.evaluate(() => globalThis.window.simulatorFixture.setActive(true));
  await cold.evaluate(() => new Promise(globalThis.requestAnimationFrame));
  assert.equal(await cold.evaluate(() => globalThis.document.querySelector("[data-simulator-setup-screen]") === globalThis.window.simulatorSetupElement), true);
  results.retainedIdentity = true;
  await cold.context().close();

  const warm = await open("");
  await warm.evaluate(() => globalThis.window.simulatorFixture.warm());
  assert.equal(await warm.evaluate(() => globalThis.window.simulatorFixture.openNow()), true, "a warmed simulator must render before the click task returns");
  results.warmFirstTask = true;
  await warm.screenshot({ path: ".context/renderer-performance/simulator-warm.png", animations: "disabled" });
  await warm.context().close();

  for (const control of ["cloud", "rolloutClosed"]) {
    const page = await open(control), requests = [];
    page.on("request", request => { if (localChunk.test(request.url())) requests.push(request.url()); });
    await page.evaluate(() => globalThis.window.simulatorFixture.warm());
    assert.equal(await page.evaluate(() => globalThis.window.simulatorFixture.openNow()), false);
    const calls = await page.evaluate(() => globalThis.window.simulatorFixture.calls);
    assert.equal(calls.some(call => ["simulator_hub_state", "simulator_hub_refresh", "simulator_view_open"].includes(call)), false);
    assert.deepEqual(requests, []);
    results[control] = { codeRequests: 0, deviceReads: 0 };
    await page.context().close();
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ results, errors }, null, 2));
} finally {
  releaseChunk?.();
  await browser?.close();
  if (server) await new Promise(done => server.httpServer.close(done));
}
