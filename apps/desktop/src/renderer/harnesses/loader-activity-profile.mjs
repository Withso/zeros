// Browser checks for actual SVG/CSS activity and shared scheduler ownership.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { build, preview } from "vite";

const entry = "apps/desktop/src/renderer/harnesses/harness-loader-activity.html";
const outDir = resolve(".context/renderer-performance/loader-dist");
let server, browser;
try {
  await build({ logLevel: "warn", build: { outDir, emptyOutDir: true,
    rollupOptions: { input: resolve(entry) } } });
  server = await preview({ configFile: false, build: { outDir },
    preview: { host: "127.0.0.1", port: 5198, strictPort: false } });
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
  const page = await browser.newPage({ viewport: { width: 1000, height: 600 }, reducedMotion: "no-preference" });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    const host = globalThis.window;
    const raf = host.requestAnimationFrame.bind(host), cancel = host.cancelAnimationFrame.bind(host);
    const timeout = host.setTimeout.bind(host), clear = host.clearTimeout.bind(host);
    const interval = host.setInterval.bind(host), clearInterval = host.clearInterval.bind(host);
    const frames = new Set(), timers = new Set(), intervals = new Set();
    let ticks = 0;
    host.requestAnimationFrame = callback => {
      const id = raf(now => { frames.delete(id); ticks++; callback(now); }); frames.add(id); return id;
    };
    host.cancelAnimationFrame = id => { frames.delete(id); cancel(id); };
    host.setTimeout = (callback, ms, ...args) => {
      const id = timeout(() => { timers.delete(id); callback(...args); }, ms); timers.add(id); return id;
    };
    host.clearTimeout = id => { timers.delete(id); clear(id); };
    host.setInterval = (callback, ms, ...args) => {
      const id = interval(callback, ms, ...args); intervals.add(id); return id;
    };
    host.clearInterval = id => { intervals.delete(id); clearInterval(id); };
    host.activityCounters = () => ({ frames: frames.size, timers: timers.size + intervals.size, ticks });
    // Native frames let observers/effects commit without becoming measured work.
    host.activityFrames = async (count = 3) => { for (let n = 0; n < count; n++) await new Promise(raf); };
  });
  const settle = () => page.evaluate(() => globalThis.window.activityFrames());
  const state = () => page.evaluate(() => ({
    ...globalThis.window.activityCounters(),
    running: globalThis.document.getAnimations().filter(animation => animation.playState === "running" || animation.playState === "pending").length,
  }));
  const report = {};
  for (const mode of ["legacy", "local"]) {
    await page.goto(`${server.resolvedUrls.local[0]}${entry}?legacy=${mode === "legacy" ? 1 : 0}`);
    await settle();
    const visible = await state();
    assert.equal(visible.frames, 1, "all active tile/label work shares one frame");
    assert.ok(visible.running > 0, "the visible design must animate");
    const scenarios = {};
    for (const scenario of ["blurred", "hidden", "offscreen", "css-hidden", "retained"]) {
      await page.evaluate(kind => {
        const fixture = globalThis.window.loaderActivityFixture;
        if (kind === "blurred") fixture.foreground(true, false);
        if (kind === "hidden") fixture.foreground(false, true);
        if (kind === "offscreen") fixture.move(true);
        if (kind === "css-hidden") fixture.hide(true);
        if (kind === "retained") fixture.retain(false);
      }, scenario);
      await settle();
      scenarios[scenario] = await state();
      if (mode === "local") {
        assert.equal(scenarios[scenario].frames, 0, `${scenario}: no Local RAF`);
        assert.equal(scenarios[scenario].timers, 0, `${scenario}: no Local timers`);
        assert.equal(scenarios[scenario].running, 0, `${scenario}: no running Local animations`);
        const ticks = scenarios[scenario].ticks;
        await page.evaluate(() => globalThis.window.activityFrames(10));
        assert.equal((await state()).ticks, ticks, `${scenario}: stays idle`);
      }
      await page.evaluate(() => {
        const fixture = globalThis.window.loaderActivityFixture;
        fixture.elapse(1_000);
        fixture.foreground(true, true); fixture.move(false); fixture.hide(false); fixture.retain(true);
      });
      await settle();
      assert.equal((await state()).frames, 1, `${scenario}: visible work resumes`);
      if (mode === "local") {
        const gap = await page.evaluate(() => globalThis.window.loaderActivityFixture.shimmerPhaseGap());
        assert.ok(gap >= 0 && gap < 0.08, `${scenario}: the phrase and shimmer resume together (phase gap ${gap})`);
      }
    }
    report[mode] = { visible, scenarios };
    await page.emulateMedia({ reducedMotion: "reduce" }); await settle();
    const reduced = await state();
    // An already-started finite transition may finish under the legacy path.
    await page.waitForFunction(() => [...globalThis.document.querySelectorAll("[data-zeros-loader], [data-run-stream]")]
      .flatMap(element => element.getAnimations({ subtree: true }))
      .every(animation => animation.playState !== "running"));
    if (mode === "local") assert.equal(reduced.frames, 0, "Local clocks need no RAF under reduced motion");
    await page.screenshot({ path: `.context/renderer-performance/loaders-${mode}.png` });
    await page.evaluate(() => globalThis.window.loaderActivityFixture.unmount()); await settle();
    assert.equal((await state()).frames, 0); assert.equal((await state()).timers, 0);
    await page.emulateMedia({ reducedMotion: "no-preference" });
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ report, errors }, null, 2));
} finally {
  await browser?.close();
  if (server) await new Promise(resolve => server.httpServer.close(resolve));
}
