import { afterAll, beforeAll, expect, it } from "vitest";
import { chromium, type Browser } from "@playwright/test";
import { buildSync } from "esbuild";
import path from "node:path";

const source = buildSync({ stdin: { resolveDir: path.resolve("apps/desktop/src/renderer/features/agent"), loader: "tsx", contents: `
  import React from "react";
  import { createRoot } from "react-dom/client";
  import { flushSync } from "react-dom";
  import { useTranscriptHistoryStatus } from "./use-transcript-history-status";
  const f = window.historyFixture = { identity: "/personal/chat", active: true, hasMessages: false,
    hasTranscript: true, resident: false, error: null, connected: true, retries: 0, recover: true, seen: [] };
  function Probe() {
    const status = useTranscriptHistoryStatus({ ...f, retry: async () => {
      f.retries++;
      if (f.recover) { f.error = null; f.resident = true; f.render(); }
    } });
    React.useLayoutEffect(() => { f.seen.push(status); });
    return <output>{status}</output>;
  }
  const app = createRoot(document.querySelector("#app"));
  f.render = () => flushSync(() => app.render(<Probe />));
` }, bundle: true, write: false, format: "iife", platform: "browser",
  define: { "process.env.NODE_ENV": '"production"', "import.meta.env": "{}" }, logLevel: "silent",
}).outputFiles[0].text;
let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser?.close(); });

it.each(["/personal/chat", "/organization/chat", "cloud://organization/workspace/chat"])("never infers a history failure from elapsed time for %s", async identity => {
  const page = await browser.newPage();
  try {
    await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
  await page.clock.pauseAt(new Date("2026-01-01T00:00:01Z"));
    await page.setContent('<div id="app"></div>');
    await page.addScriptTag({ content: source });
    await page.evaluate(identity => { const f = (window as any).historyFixture; f.identity = identity; f.render(); }, identity);
    await page.clock.runFor(250);
    expect(await page.locator("output").textContent()).toBe("loading");
    await page.clock.runFor(3_000);
    expect(await page.locator("output").textContent()).toBe("waiting");
    await page.clock.runFor(60_000);
    expect(await page.locator("output").textContent()).toBe("waiting");
    expect(await page.evaluate(() => (window as any).historyFixture.retries)).toBe(0);
    await page.evaluate(() => { const f = (window as any).historyFixture; f.resident = true; f.render(); });
    expect(await page.locator("output").textContent()).toBe("none");
    expect(await page.evaluate(() => (window as any).historyFixture.seen.includes("unavailable"))).toBe(false);
  } finally { await page.close(); }
});
it.each([true, false])("retries actual failures quietly and only reports one that persists (recovers=%s)", async recover => {
  const page = await browser.newPage();
  try {
    await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
  await page.clock.pauseAt(new Date("2026-01-01T00:00:01Z"));
    await page.setContent('<div id="app"></div>');
    await page.addScriptTag({ content: source });
    await page.evaluate(recover => { const f = (window as any).historyFixture; f.recover = recover; f.error = "Couldn't read history"; f.render(); }, recover);
    await page.clock.runFor(1_499);
    expect(await page.evaluate(() => (window as any).historyFixture.seen.includes("unavailable"))).toBe(false);
    await page.clock.runFor(1);
    await page.waitForFunction(expected => document.querySelector("output")?.textContent === expected, recover ? "none" : "unavailable");
    expect(await page.evaluate(() => (window as any).historyFixture.retries)).toBe(1);
    expect(await page.locator("output").textContent()).toBe(recover ? "none" : "unavailable");
    if (recover) expect(await page.evaluate(() => (window as any).historyFixture.seen.includes("unavailable"))).toBe(false);
  } finally { await page.close(); }
});
