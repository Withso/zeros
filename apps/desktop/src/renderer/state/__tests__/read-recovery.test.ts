import { afterAll, beforeAll, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "@playwright/test";
import { buildSync } from "esbuild";
import path from "node:path";

// Exercise real React commits, shared caches and retry clocks. Assertions also
// inspect every committed state, so a one-frame error cannot pass by recovering
// before an eventual DOM assertion.
const source = buildSync({
  stdin: { resolveDir: path.resolve("apps/desktop/src/renderer"), loader: "tsx", contents: `
    import React, { useLayoutEffect } from "react";
    import { createRoot } from "react-dom/client";
    import { flushSync } from "react-dom";
    import { KeyedAsyncCache } from "./shared/lib/keyed-async-cache";
    import { useRecoveringRead } from "./state/use-recovering-read";
    const cache = new KeyedAsyncCache(8);
    const f = window.recovery = { key: "/personal/a", active: true, connected: true,
      copies: 1, plans: {}, attempts: [], paints: [], held: {}, cache };
    function Probe({ id }) {
      const read = useRecoveringRead(cache, f.key, async key => {
        f.attempts.push(key);
        const next = f.plans[key]?.shift() ?? "rows";
        if (next === "fail") throw new Error("read failed");
        if (next === "unsupported") throw Object.assign(new Error("This operation is not available in cloud workspaces yet."), { code: "CLOUD_V2_UNSUPPORTED" });
        if (next === "hold") return new Promise((resolve, reject) => f.held[key] = { resolve, reject });
        return next;
      }, { maxAgeMs: 30_000, enabled: f.active, connected: f.connected, folder: f.key });
      f.refresh = read.refresh;
      const view = { id, key: f.key, data: read.data ?? null, error: read.error?.message ?? null,
        readError: read.readError?.message ?? null,
        pending: read.loading || read.refreshing };
      useLayoutEffect(() => { f.paints.push(view); });
      return <output data-reader={id}>{JSON.stringify(view)}</output>;
    }
    const app = createRoot(document.querySelector("#app"));
    f.render = () => flushSync(() => app.render(Array.from({ length: f.copies }, (_, id) => <Probe key={id} id={id} />)));
    f.stop = () => flushSync(() => app.unmount());
  ` },
  bundle: true, write: false, format: "iife", platform: "browser",
  define: { "process.env.NODE_ENV": '"production"', "import.meta.env": "{}" },
  logLevel: "silent",
}).outputFiles[0].text;

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser?.close(); });
async function fixture(): Promise<Page> {
  const page = await browser.newPage();
  await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
  await page.clock.pauseAt(new Date("2026-01-01T00:00:01Z"));
  await page.setContent('<div id="app"></div>');
  await page.addScriptTag({ content: source });
  return page;
}
const cloud = "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
it("keeps a definitive unsupported response visible instead of loading forever", async () => {
  const page = await fixture();
  try {
    await page.evaluate(key => {
      const f = (window as any).recovery;
      f.key = key; f.plans[key] = ["unsupported"]; f.render();
    }, cloud);
    await page.waitForFunction(() => (window as any).recovery.cache.getSnapshot((window as any).recovery.key).error !== null);
    const view = JSON.parse(await page.locator("output").innerText());
    expect(view.error).toBe("This operation is not available in cloud workspaces yet.");
    expect(view.pending).toBe(false);
    await page.clock.runFor(60_000);
    expect(await page.evaluate(() => (window as any).recovery.attempts.length)).toBe(1);
  } finally { await page.close(); }
});
for (const key of ["/personal/a", "/organization/a", cloud]) {
  it.each([false, true])(`recovers ${key} silently, retaining confirmed data (%s)`, async retained => {
    const page = await fixture();
    try {
      await page.evaluate(({ key, retained }) => {
        const f = (window as any).recovery;
        f.key = key;
        if (retained) { f.cache.setData(key, "confirmed"); f.cache.invalidate(key); }
        f.plans[key] = ["fail", "recovered"];
        f.render();
      }, { key, retained });
      await page.waitForFunction(() => (window as any).recovery.attempts.length === 1);
      await page.clock.runFor(1_500);
      await page.waitForFunction(() => document.querySelector("output")?.textContent?.includes("recovered"));
      const f = await page.evaluate(() => {
        const f = (window as any).recovery;
        return { attempts: f.attempts, paints: f.paints };
      });
      expect(f.attempts).toEqual([key, key]);
      expect(f.paints.every((paint: { error: unknown }) => paint.error === null)).toBe(true);
      if (!retained) expect(f.paints.every((paint: { data: unknown; pending: boolean }) => paint.data !== null || paint.pending)).toBe(true);
      if (retained) expect(f.paints.every((paint: { data: unknown }) => paint.data !== null)).toBe(true);
    } finally { await page.close(); }
  });
}
it("deduplicates a silent retry across readers and keeps a confirmed failure visible until recovery", async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => {
      const f = (window as any).recovery;
      f.copies = 2; f.plans[f.key] = ["fail", "fail", "recovered"]; f.render();
    });
    await page.waitForFunction(() => (window as any).recovery.attempts.length === 1);
    await page.clock.runFor(1_500);
    await page.waitForFunction(() => [...document.querySelectorAll("output")].every(node => JSON.parse(node.textContent ?? "{}").error === "read failed"));
    expect(await page.evaluate(() => (window as any).recovery.attempts.length)).toBe(2);
    await page.clock.runFor(60_000);
    expect(await page.evaluate(() => (window as any).recovery.attempts.length)).toBe(2);
    await page.evaluate(() => (window as any).recovery.refresh());
    await page.waitForFunction(() => [...document.querySelectorAll("output")].every(node => node.textContent?.includes("recovered")));
    expect(await page.evaluate(() => (window as any).recovery.attempts.length)).toBe(3);
  } finally { await page.close(); }
});
it("keeps a failed read unsafe until the retry confirms a successful result", async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => {
      const f = (window as any).recovery;
      f.cache.setData(f.key, "confirmed"); f.cache.invalidate(f.key);
      f.plans[f.key] = ["fail", "hold"]; f.render();
    });
    await page.waitForFunction(() => (window as any).recovery.attempts.length === 1);
    await page.clock.runFor(1_500);
    await page.waitForFunction(() => Boolean((window as any).recovery.held[(window as any).recovery.key]));
    expect(JSON.parse(await page.locator("output").innerText())).toMatchObject({
      data: "confirmed", error: null, readError: "read failed", pending: true,
    });
    await page.evaluate(() => {
      const f = (window as any).recovery;
      f.held[f.key].resolve("recovered");
    });
    await page.waitForFunction(() => document.querySelector("output")?.textContent?.includes("recovered"));
    expect(JSON.parse(await page.locator("output").innerText()).readError).toBeNull();
  } finally { await page.close(); }
});
it.each(["hidden", "disconnected"])("pauses recovery while %s and revalidates quietly on return", async reason => {
  const page = await fixture();
  try {
    await page.evaluate(() => {
      const f = (window as any).recovery;
      f.plans[f.key] = ["fail", "recovered"]; f.render();
    });
    await page.waitForFunction(() => (window as any).recovery.attempts.length === 1);
    await page.evaluate(reason => {
      const f = (window as any).recovery;
      f[reason === "hidden" ? "active" : "connected"] = false; f.render();
    }, reason);
    await page.clock.runFor(60_000);
    expect(await page.evaluate(() => (window as any).recovery.attempts.length)).toBe(1);
    await page.evaluate(() => {
      const f = (window as any).recovery;
      f.active = f.connected = true; f.render();
    });
    await page.waitForFunction(() => document.querySelector("output")?.textContent?.includes("recovered"));
    expect(await page.evaluate(() => (window as any).recovery.paints.every((p: any) => p.error === null))).toBe(true);
  } finally { await page.close(); }
});
it("fences late failures after Local → cloud → Local and cancels an unmounted retry", async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => {
      const f = (window as any).recovery;
      f.plans[f.key] = ["fail", "hold", "restored"]; f.render();
    });
    await page.waitForFunction(() => (window as any).recovery.attempts.length === 1);
    await page.clock.runFor(1_500);
    await page.waitForFunction(() => Boolean((window as any).recovery.held["/personal/a"]));
    await page.evaluate(cloud => {
      const f = (window as any).recovery;
      f.key = cloud; f.render(); f.held["/personal/a"].reject(new Error("retired read"));
    }, cloud);
    await page.waitForFunction(() => document.querySelector("output")?.textContent?.includes('"data":"rows"'));
    expect(await page.evaluate(cloud => (window as any).recovery.paints.filter((p: any) => p.key === cloud).every((p: any) => p.error === null), cloud)).toBe(true);
    await page.evaluate(() => { const f = (window as any).recovery; f.key = "/personal/a"; f.render(); });
    await page.waitForFunction(() => document.querySelector("output")?.textContent?.includes("restored"));
    await page.evaluate(() => {
      const f = (window as any).recovery;
      f.plans[f.key] = ["fail"]; f.refresh();
    });
    await page.waitForFunction(() => (window as any).recovery.cache.getSnapshot("/personal/a").error !== null);
    const attempts = await page.evaluate(() => { const f = (window as any).recovery; f.stop(); return f.attempts.length; });
    await page.clock.runFor(60_000);
    expect(await page.evaluate(() => (window as any).recovery.attempts.length)).toBe(attempts);
  } finally { await page.close(); }
});
