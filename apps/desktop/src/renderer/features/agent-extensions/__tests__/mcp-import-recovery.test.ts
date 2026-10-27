import { readFileSync } from "node:fs";
import path from "node:path";
import { buildSync } from "esbuild";
import { chromium } from "@playwright/test";
import { expect, it } from "vitest";

// Mount the actual scan/recovery hooks, recording every React commit. A final
// successful DOM alone misses a flash while an effect-driven retry starts.
const component = readFileSync(new URL("../mcp-import-dialog.tsx", import.meta.url), "utf8");
const scan = component.slice(component.indexOf("  const [sources,"), component.indexOf("  const toggle ="));
const script = buildSync({
  stdin: { resolveDir: path.resolve("apps/desktop/src/renderer"), loader: "tsx", contents: `
    import React, { useState, useEffect, useMemo, useCallback, useRef, useLayoutEffect } from "react";
    import { createRoot } from "react-dom/client";
    import { flushSync } from "react-dom";
    import { useReadRecovery } from "./state/use-read-recovery";
    import { useDocumentActive } from "./state/use-document-active";
    const f = window.scan = { open: true, status: "connected", attempts: 0, paints: [], settled: null, plans: ["fail", "hold"] };
    const bridge = {}, projects = [], existingNames = new Set();
    const keyOf = (source, name) => source + "::" + name;
    const useBridgeStatus = () => f.status;
    const bridgeMcpResolveComposed = async () => [];
    const bridgeMcpScanNative = () => {
      f.attempts++;
      const plan = f.plans.shift() ?? [];
      if (plan === "fail") return Promise.reject(new Error("temporary scan failure"));
      if (plan === "hold") return new Promise(resolve => f.settled = resolve);
      return Promise.resolve(plan);
    };
    function Probe() {
      const open = f.open;
      const setComposedNames = () => {};
      ${scan}
      f.setSelected = setSelected;
      const view = { error: recovery.error?.message ?? null, pending: recovery.pending, sources, selected: [...selected] };
      useLayoutEffect(() => { f.paints.push(view); });
      return <output>{JSON.stringify(view)}</output>;
    }
    const root = createRoot(document.querySelector("#app"));
    f.render = () => flushSync(() => root.render(<Probe />));
  ` },
  bundle: true, write: false, format: "iife", platform: "browser",
  define: { "process.env.NODE_ENV": '"production"', "import.meta.env": "{}" }, logLevel: "silent",
}).outputFiles[0].text;

it("does not report a persistent MCP scan failure before its effect-driven retry settles", async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
    await page.clock.pauseAt(new Date("2026-01-01T00:00:01Z"));
    await page.setContent('<div id="app"></div>');
    await page.addScriptTag({ content: script });
    await page.evaluate(() => (window as any).scan.render());
    await page.waitForFunction(() => (window as any).scan.attempts === 1);
    await page.clock.runFor(1_500);
    await page.waitForFunction(() => (window as any).scan.attempts === 2);
    await page.evaluate(() => (window as any).scan.settled([]));
    await page.waitForFunction(() => document.querySelector("output")?.textContent?.includes('"sources":[]'));
    expect(await page.evaluate(() => (window as any).scan.paints.every((paint: any) => paint.error === null))).toBe(true);
  } finally { await browser.close(); }
});

it("prunes removed MCP selections after reconnect without selecting new or unchecked servers", async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="app"></div>');
    await page.addScriptTag({ content: script });
    await page.evaluate(() => {
      const f = (window as any).scan;
      f.plans = [[{ source: "cursor", servers: ["keep", "removed", "unchecked"].map(name => ({ name })) }]];
      f.render();
    });
    await page.waitForFunction(() => JSON.parse(document.querySelector("output")!.textContent!).selected.length === 3);
    await page.evaluate(() => {
      const f = (window as any).scan;
      f.setSelected(new Set(["cursor::keep", "cursor::removed"]));
      f.status = "connecting"; f.render();
    });
    await page.evaluate(() => {
      const f = (window as any).scan;
      f.plans = [[{ source: "cursor", servers: ["keep", "unchecked", "new"].map(name => ({ name })) }]];
      f.status = "connected"; f.render();
    });
    await page.waitForFunction(() => JSON.parse(document.querySelector("output")!.textContent!).sources[0].servers.some((s: any) => s.name === "new"));
    expect(JSON.parse(await page.locator("output").innerText()).selected).toEqual(["cursor::keep"]);
    await page.evaluate(() => { const f = (window as any).scan; f.status = "connecting"; f.render(); });
    await page.evaluate(() => { const f = (window as any).scan; f.status = "connected"; f.render(); });
    await page.waitForFunction(() => JSON.parse(document.querySelector("output")!.textContent!).sources.length === 0);
    expect(JSON.parse(await page.locator("output").innerText()).selected).toEqual([]);
  } finally { await browser.close(); }
});
