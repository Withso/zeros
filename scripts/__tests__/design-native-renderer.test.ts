import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "@playwright/test";
import { evaluateNativeRenderer, runNativeRendererAction, waitForNativeRenderer, withNativeRendererModules } from "../design-native-renderer.mjs";

async function openVersionedRenderer(browser: Browser) {
  const page = await browser.newPage();
  await page.route("http://native-renderer.test/**", route => {
    const url = new URL(route.request().url());
    return route.fulfill(url.pathname === "/" ? {
      contentType: "text/html", body: '<main></main><script type="module">import { state } from "/apps/native-store.ts?t=42"; state.ready=true; window.nativeState=state; document.querySelector("main").textContent="ready";</script>',
    } : { contentType: "text/javascript", body: "export const state = { ready: false, actions: 0 };" });
  });
  await page.goto("http://native-renderer.test/");
  await page.locator("main").filter({ hasText: "ready" }).waitFor();
  return page;
}

describe("native product renderer readiness", () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
  afterAll(async () => { await browser?.close(); });

  it("uses the same bundled stores as the production app without importing development source", async () => {
    const page = await browser.newPage();
    const requests: string[] = [];
    await page.route("http://native-production.test/**", route => {
      const url = new URL(route.request().url()); requests.push(url.pathname);
      const responses: Record<string, string> = {
        "/": '<main></main><script type="module">import { state } from "/assets/store.js"; state.ready=true; window.nativeState=state; document.querySelector("main").textContent="ready";</script>',
        "/assets/store.js": "export const state = { ready: false, actions: 0 };",
        "/assets/qualification.js": 'import * as store from "./store.js"; export const modules = { "/apps/native-store.ts": store };',
      };
      return route.fulfill({ status: responses[url.pathname] ? 200 : 404,
        contentType: url.pathname === "/" ? "text/html" : "text/javascript", body: responses[url.pathname] ?? "" });
    });
    try {
      await page.goto("http://native-production.test/");
      await page.locator("main").filter({ hasText: "ready" }).waitFor();
      const driver = await withNativeRendererModules(page, { moduleUrl: "http://native-production.test/assets/qualification.js" });
      const action = new Function('return async () => { const {state}=await import("/apps/native-store.ts"); if(!state.ready)throw Error("Duplicate store"); state.actions++; };')();
      await runNativeRendererAction(driver, action, undefined, 1_000);
      expect(await page.evaluate(() => (window as unknown as { nativeState: { actions: number } }).nativeState.actions)).toBe(1);
      expect(requests).not.toContain("/apps/native-store.ts");
      const missing = new Function('return async () => import("/apps/missing.ts");')();
      await expect(driver.evaluate(missing)).rejects.toThrow("not in the production qualification bundle");
    } finally { await page.close(); }
  });

  it("reads the app's loaded Vite module instead of constructing a second bare-import store", async () => {
    const page = await openVersionedRenderer(browser);
    try {
      // Keep Vitest's SSR import transform out of this browser-owned function.
      const predicate = new Function('return async () => (await import("/apps/native-store.ts")).state.ready;')();
      await waitForNativeRenderer(page, predicate, undefined, 500);
    } finally { await page.close(); }
  });

  it("mutates the same versioned store the app renders and acknowledges the action once", async () => {
    const page = await openVersionedRenderer(browser);
    try {
      const action = new Function('return async () => { (await import("/apps/native-store.ts")).state.actions++; };')();
      await runNativeRendererAction(page, action, undefined, 1_000);
      expect(await page.evaluate(() => (window as unknown as { nativeState: { actions: number } }).nativeState.actions)).toBe(1);
    } finally { await page.close(); }
  });

  it("keeps direct driver evaluations and shared helpers on the rendered module instance", async () => {
    const page = await openVersionedRenderer(browser);
    try {
      const driver = await withNativeRendererModules(page);
      const read = new Function('return async () => (await import("/apps/native-store.ts")).state.ready;')();
      expect(await driver.evaluate(read)).toBe(true);
      await waitForNativeRenderer(driver, read, undefined, 500);
      expect(await driver.locator("main").textContent()).toBe("ready");
    } finally { await page.close(); }
  });

  it("roots asynchronous evaluations through GC and reports their bounded deadline", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<main data-evaluations="0"></main>');
      const outcome = evaluateNativeRenderer(page, () => {
        document.querySelector("main")!.setAttribute("data-evaluations", "1");
        return new Promise(() => {});
      }, undefined, 500).then(() => null, (error: Error) => error.message);
      await page.locator('[data-evaluations="1"]').waitFor({ state: "attached" });
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("HeapProfiler.collectGarbage");
      const bounded = await Promise.race([outcome, new Promise<string>(resolve => setTimeout(() => resolve("Missing evaluation deadline"), 1_500))]);
      expect(bounded).toContain("Native renderer evaluation did not finish before its acknowledgement deadline");
      expect(await page.locator("main").getAttribute("data-evaluations")).toBe("1");
      await cdp.detach();
    } finally { await page.close(); }
  });

  it("awaits asynchronous false results and probes again before continuing", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<main data-probes="0"></main>');
      await waitForNativeRenderer(page, async () => {
        const node = document.querySelector("main")!;
        const probes = Number(node.getAttribute("data-probes")) + 1;
        node.setAttribute("data-probes", String(probes));
        // The production probe imports the bridge module asynchronously.
        await Promise.resolve();
        return probes >= 3;
      }, undefined, 2_000);
      expect(await page.locator("main").getAttribute("data-probes")).toBe("3");
    } finally { await page.close(); }
  });

  it("fails the qualification when asynchronous readiness never arrives", async () => {
    const page = await browser.newPage();
    try {
      await expect(waitForNativeRenderer(page, async () => false, undefined, 150))
        .rejects.toThrow();
    } finally { await page.close(); }
  });

  it("keeps a pending action until its bounded acknowledgement deadline despite renderer GC", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<main data-actions="0"></main>');
      const origin = await page.evaluate(() => performance.timeOrigin);
      const outcome = runNativeRendererAction(page, () => {
        document.querySelector("main")!.setAttribute("data-actions", "1");
        // A protocol waiter alone does not root this promise in Chromium.
        return new Promise(() => {});
      }, undefined, 600).then(() => null, (error: Error) => error.message);
      await page.locator('[data-actions="1"]').waitFor({ state: "attached" });
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("HeapProfiler.collectGarbage");
      const bounded = await Promise.race([outcome, new Promise<string>(resolve => setTimeout(() => resolve("Missing bounded action acknowledgement"), 1_500))]);
      expect(bounded).toContain("Native renderer action did not finish");
      expect(await page.evaluate(() => performance.timeOrigin)).toBe(origin);
      expect(await page.locator("main").getAttribute("data-actions")).toBe("1");
      await cdp.detach();
    } finally { await page.close(); }
  });

  it("runs an asynchronous mutation once and preserves its explicit failure", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<main data-actions="0"></main>');
      await expect(runNativeRendererAction(page, async () => {
        const node = document.querySelector("main")!;
        node.setAttribute("data-actions", String(Number(node.getAttribute("data-actions")) + 1));
        await Promise.resolve();
        throw new Error("Qualification action failed");
      }, undefined, 1_000)).rejects.toThrow("Qualification action failed");
      expect(await page.locator("main").getAttribute("data-actions")).toBe("1");
    } finally { await page.close(); }
  });

  it("acknowledges completion without repeating the action", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<main data-actions="0"></main>');
      await runNativeRendererAction(page, async value => {
        await Promise.resolve();
        const node = document.querySelector("main")!;
        node.setAttribute("data-actions", String(Number(node.getAttribute("data-actions")) + value));
      }, 1, 1_000);
      expect(await page.locator("main").getAttribute("data-actions")).toBe("1");
    } finally { await page.close(); }
  });

  it("rejects a replaced document instead of replaying a pending mutation", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<main data-actions="0"></main>');
      const outcome = runNativeRendererAction(page, () => {
        document.querySelector("main")!.setAttribute("data-actions", "1");
        return new Promise(() => {});
      }, undefined, 1_000).then(() => null, (error: Error) => error.message);
      await page.locator('[data-actions="1"]').waitFor({ state: "attached" });
      await page.goto('data:text/html,<main data-actions="0"></main>');
      expect(await outcome).toContain("Native renderer action acknowledgement was lost");
      expect(await page.locator("main").getAttribute("data-actions")).toBe("0");
    } finally { await page.close(); }
  });
});
