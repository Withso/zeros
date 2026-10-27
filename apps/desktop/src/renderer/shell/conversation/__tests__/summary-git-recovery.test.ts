import { afterAll, beforeAll, expect, it } from "vitest";
import { chromium, type Browser } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";

let browser: Browser;
let script: string;
beforeAll(async () => {
  const renderer = path.resolve("apps/desktop/src/renderer");
  // Replace transport boundaries, retaining the real Summary cache, hook and
  // recovery lifecycle. The component suite separately checks every action.
  const replacements = new Map(Object.entries({
    "platform/git": "export const ghPrGet = async () => null;",
    "platform/bridge/use-bridge": "export const useBridgeStatus = () => window.summary.status;",
    "state/local-main-workspace": "export const isLocalMainWorkspace = workspace => workspace.id.startsWith('local:');",
    "shell/use-git-refresh-key": "export const useGitRefreshKey = () => 1;",
    "shell/git-status-reads": `
      export const statusForGeneration = async () => window.summary.read();
      export const changeCountsForGeneration = async () => ({ all: 2, uncommitted: 1 });
    `,
  }).map(([file, contents]) => [path.join(renderer, file), contents]));
  const bundle = await build({
    stdin: { resolveDir: renderer, loader: "tsx", contents: `
      import React, { useLayoutEffect } from "react";
      import { createRoot } from "react-dom/client";
      import { flushSync } from "react-dom";
      import { useSummaryGitStatus, summaryGitSnapshotForTesting } from "./shell/conversation/summary-git-status-data";
      const status = { conflicted: [], conflictState: null, ahead: 1, behind: 0,
        upstream: "origin/feature", summary: { branch: "feature", base: null } };
      const f = window.summary = { status: "connected", plans: [], attempts: 0, paints: [], held: null };
      f.read = async () => {
        f.attempts++;
        const next = f.plans.shift();
        if (next === "fail") throw new Error("Git unavailable");
        if (next === "hold") return new Promise(resolve => f.held = () => resolve({ ...status, ahead: 2 }));
        return status;
      };
      function Probe() {
        const read = useSummaryGitStatus(f.workspace, true);
        f.refresh = read.refresh;
        f.snapshot = () => summaryGitSnapshotForTesting(f.workspace);
        const view = { data: read.git.data, error: read.error?.message ?? null,
          readError: read.readError?.message ?? null, connected: read.connected,
          pending: read.git.loading || read.git.refreshing };
        useLayoutEffect(() => { f.paints.push(view); });
        return <output>{JSON.stringify(view)}</output>;
      }
      const root = createRoot(document.querySelector("#app"));
      f.render = () => flushSync(() => root.render(<Probe />));
    ` },
    plugins: [{ name: "summary-transport", setup(builder) {
      builder.onResolve({ filter: /^\./ }, args => {
        const file = path.resolve(args.resolveDir, args.path);
        return replacements.has(file) ? { path: file, namespace: "summary-transport" } : undefined;
      });
      builder.onLoad({ filter: /.*/, namespace: "summary-transport" }, args => ({ contents: replacements.get(args.path) }));
    } }],
    bundle: true, write: false, format: "iife", platform: "browser",
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env": "{}" },
    logLevel: "silent",
  });
  script = bundle.outputFiles[0].text;
  browser = await chromium.launch();
});
afterAll(async () => { await browser?.close(); });

it.each(["/personal/worktree", "/organization/worktree"])("retains Summary read safety through a held retry for %s", async folder => {
  const page = await browser.newPage();
  try {
    await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
    await page.clock.pauseAt(new Date("2026-01-01T00:00:01Z"));
    await page.setContent('<div id="app"></div>');
    await page.addScriptTag({ content: script });
    await page.evaluate(folder => {
      const f = (window as any).summary;
      f.workspace = { id: folder, path: folder, repoRoot: folder, branch: "feature", baseBranch: "main", prNumber: null,
        organizationId: folder.startsWith("/organization/") ? "example" : null };
      f.render();
    }, folder);
    await page.waitForFunction(() => JSON.parse(document.querySelector("output")!.textContent!).data?.ahead === 1);
    await page.evaluate(() => {
      const f = (window as any).summary;
      f.plans = ["fail", "hold"]; f.refresh();
    });
    await page.waitForFunction(() => (window as any).summary.snapshot().error !== null);
    await page.clock.runFor(1_500);
    await page.waitForFunction(() => Boolean((window as any).summary.held));
    expect(JSON.parse(await page.locator("output").innerText())).toMatchObject({
      data: { ahead: 1 }, error: null, readError: "Git unavailable", pending: true,
    });
    await page.evaluate(() => (window as any).summary.held());
    await page.waitForFunction(() => JSON.parse(document.querySelector("output")!.textContent!).data?.ahead === 2);
    expect(JSON.parse(await page.locator("output").innerText()).readError).toBeNull();
    await page.evaluate(() => { const f = (window as any).summary; f.status = "connecting"; f.render(); });
    expect(JSON.parse(await page.locator("output").innerText())).toMatchObject({ connected: false, data: { ahead: 2 }, error: null });
    expect(await page.evaluate(() => (window as any).summary.paints.every((view: any) => view.error === null))).toBe(true);
    expect(await page.evaluate(() => (window as any).summary.attempts)).toBe(3);
  } finally { await page.close(); }
});
