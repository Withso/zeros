// Standalone browser regression using the real renderer and stores. Pass
// --production for the production profiling runtime; no root config changes.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { build, createServer, preview } from "vite";

const production = process.argv.includes("--production");
const kind = process.argv.find(arg => arg.startsWith("--kind="))?.slice(7) ?? "prose";
const entry = "apps/desktop/src/renderer/harnesses/harness-stream-renders.html";
const outDir = resolve(".context/renderer-performance/profile-dist");
let server, browser;
try {
  if (production) {
    const profiling = createRequire(import.meta.url).resolve(
      "react-dom/profiling",
    );
    await build({
      logLevel: "warn",
      resolve: {
        alias: [{ find: /^react-dom(?:\/client)?$/, replacement: profiling }],
      },
      build: {
        outDir,
        emptyOutDir: true,
        minify: false,
        rollupOptions: { input: resolve(entry) },
      },
    });
    server = await preview({
      configFile: false,
      build: { outDir },
      preview: { host: "127.0.0.1", port: 5197, strictPort: false },
    });
  } else {
    server = await createServer({
      server: { host: "127.0.0.1", port: 5197, strictPort: false },
      clearScreen: false,
    });
    await server.listen();
  }
  browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH,
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "reduce",
  });
  await page.addInitScript(() => { Date.now = () => 10_000; });
  const errors = [];
  page.on("pageerror", (error) => {
    errors.push(error.message);
    console.error(error.stack);
  });
  page.on("console", (message) => {
    if (message.type() === "error") console.error(message.text());
  });
  const runs = { baseline: [], optimized: [] };
  for (let round = 0; round < 3; round++)
    for (const mode of ["baseline", "optimized"]) {
      await page.goto(
        `${server.resolvedUrls.local[0]}${entry}?baseline=${mode === "baseline" ? 1 : 0}&kind=${kind}`,
      );
      await page
        .locator("[data-chat='stream-A'] .zeros-agent-surface")
        .waitFor();
      await page.evaluate(() => new Promise(globalThis.requestAnimationFrame));
      if (kind !== "prose") await page.locator("[data-chat='stream-A'] .zeros-agent-messages [aria-expanded='false']").first().click();
      const visible = await page.evaluate(() =>
        globalThis.window.streamRenderFixture.measure(),
      );
      if (round === 2) await page.screenshot({
        path: `.context/renderer-performance/stream-${kind}-${mode}.png`, animations: "disabled",
      });
      await page.evaluate(() =>
        globalThis.window.streamRenderFixture.select("stream-B"),
      );
      const hidden = await page.evaluate(() =>
        globalThis.window.streamRenderFixture.measure(),
      );
      runs[mode].push({ visible, hidden });
      assert.deepEqual(errors, []);
      if (mode !== "optimized") continue;
      assert.equal(
        visible.paintedLatest,
        true,
        "the live message must paint every published frame",
      );
      assert.ok(
        visible.commits["stream-A"] > 0,
        "the profiling runtime must count real commits",
      );
      assert.ok(
        visible.commits["stream-A"] <= visible.frames,
        "one live commit per frame",
      );
      assert.equal(
        visible.renders.AgentChatBody ?? 0,
        0,
        "streamed text must not rerender chat/composer chrome",
      );
      for (const surface of [
        "sidebar",
        "header",
        "tabs",
        "workbench",
        "stream-B",
      ])
        assert.equal(
          visible.commits[surface] ?? 0,
          0,
          `${surface} must stay inert while A streams`,
        );
      assert.equal(
        hidden.commits["stream-A"] ?? 0,
        0,
        "hidden A must not render",
      );
      assert.equal(
        hidden.commits["stream-B"] ?? 0,
        0,
        "visible B must not render for A's stream",
      );
    }
  const median = (values) => values.toSorted((a, b) => a - b)[1];
  const summary = Object.fromEntries(
    Object.entries(runs).map(([mode, values]) => [
      mode,
      {
        publications: median(values.map((x) => x.visible.publications)),
        liveCommits: median(
          values.map((x) => x.visible.commits["stream-A"] ?? 0),
        ),
        chatRendersPerDelta: median(
          values.map(
            (x) =>
              (x.visible.renders.AgentChatBody ?? 0) /
              (x.visible.frames * x.visible.deltas),
          ),
        ),
        hiddenChatCommits: median(
          values.map((x) => x.hidden.commits["stream-A"] ?? 0),
        ),
      },
    ]),
  );
  let scroll;
  const markdownBoundaries = await page.evaluate(() => globalThis.window.streamRenderFixture.verifyMarkdown());
  if (kind === "prose") {
    await page.evaluate(() => globalThis.window.streamRenderFixture.select("stream-A"));
    await page.evaluate(() => globalThis.window.streamRenderFixture.appendText("\n\nA paragraph of growing prose.\n\n".repeat(60)));
    const scroller = "[data-chat='stream-A'] .zeros-agent-body";
    await page.waitForFunction(selector => {
      const el = globalThis.document.querySelector(selector);
      return el.scrollHeight > el.clientHeight * 2 && el.scrollHeight - el.scrollTop - el.clientHeight <= 1;
    }, scroller);
    // Let the initial overflowing layout and its scroll event settle before
    // counting the next text update, which must reach only the live leaf.
    await page.evaluate(async () => { for (let n = 0; n < 3; n++) await new Promise(globalThis.requestAnimationFrame); });
    await page.evaluate(() => { globalThis.window.streamRenderCounts = {}; });
    await page.evaluate(() => globalThis.window.streamRenderFixture.appendText("\n\nMore growing prose.\n\n".repeat(10)));
    await page.waitForFunction(selector => {
      const el = globalThis.document.querySelector(selector);
      return el.scrollHeight - el.scrollTop - el.clientHeight <= 1;
    }, scroller);
    await page.evaluate(async () => { for (let n = 0; n < 3; n++) await new Promise(globalThis.requestAnimationFrame); });
    const followed = await page.evaluate(selector => {
      const el = globalThis.document.querySelector(selector);
      return { gap: el.scrollHeight - el.scrollTop - el.clientHeight, parentRenders: globalThis.window.streamRenderCounts.AgentChatBody ?? 0 };
    }, scroller);
    assert.equal(followed.parentRenders, 0, "sticky bottom must follow leaf growth without a chat render");
    assert.ok(followed.gap <= 1, "leaf growth must stay pinned to the bottom");
    await page.locator(scroller).hover();
    await page.mouse.wheel(0, -500);
    await page.getByRole("button", { name: "Jump to latest", exact: true }).waitFor();
    await page.evaluate(async () => { for (let n = 0; n < 3; n++) await new Promise(globalThis.requestAnimationFrame); });
    const reading = await page.locator(scroller).evaluate(el => el.scrollTop);
    await page.evaluate(() => globalThis.window.streamRenderFixture.appendText("\n\nContent below the reading position.\n\n".repeat(10)));
    await page.evaluate(async () => { for (let n = 0; n < 3; n++) await new Promise(globalThis.requestAnimationFrame); });
    const after = await page.locator(scroller).evaluate(el => el.scrollTop);
    assert.ok(Math.abs(after - reading) <= 1, "new leaf text must preserve the reader's scroll position");
    await page.getByRole("button", { name: "Jump to latest", exact: true }).click();
    await page.waitForFunction(selector => {
      const el = globalThis.document.querySelector(selector);
      return el.scrollHeight - el.scrollTop - el.clientHeight <= 1;
    }, scroller);
    scroll = { ...followed, readingPreserved: true, jumpToLatest: true };
  }
  console.log(JSON.stringify({ production, kind, summary, runs, markdownBoundaries, scroll, errors }, null, 2));
} finally {
  await browser?.close();
  if (server?.close) await server.close();
  else await new Promise((resolve) => server?.httpServer.close(resolve));
}
