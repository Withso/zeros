#!/usr/bin/env node
// Focused Design smoke and a reproducible renderer baseline. Chromium/CDP
// metrics describe this renderer, not Electron/GPU RSS or macOS energy use.
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runDesignWorkspaceSmoke } from "./ui-smoke-design-workspace.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, ".context", "design-renderer-baseline.json");
const measureOnly = process.argv.includes("--measure-only");
const port = await new Promise((resolve, reject) => {
  const socket = net.createServer();
  socket.once("error", reject);
  socket.listen(0, "127.0.0.1", () => {
    const chosen = socket.address().port;
    socket.close(() => resolve(chosen));
  });
});
const origin = `http://127.0.0.1:${port}`;
const vite = spawn(
  "pnpm",
  [
    "exec",
    "vite",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--strictPort",
  ],
  { cwd: root, stdio: "ignore", detached: true },
);
let browser;
const failures = [];
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (vite.exitCode !== null)
      throw new Error("Design baseline dev server exited.");
    try {
      ready = (await fetch(origin)).ok;
    } catch {
      /* startup */
    }
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error("Design baseline dev server did not start.");
  browser = await chromium.launch({ headless: true });
  let page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  page.on("pageerror", (error) => failures.push(error.message));
  const check = (name, passed, detail = "") => {
    if (!passed) failures.push(`${name}: ${detail}`);
    console.log(`${passed ? "PASS" : "FAIL"} ${name}`);
  };
  const waitFor = async (predicate, label) => {
    const until = Date.now() + 10_000;
    while (Date.now() < until) {
      if (await predicate()) return true;
      await page.waitForTimeout(50);
    }
    console.error(`Timed out: ${label}`);
    return false;
  };
  if (!measureOnly) {
    await page.goto(
      `${origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html`,
      { waitUntil: "networkidle" },
    );
    await runDesignWorkspaceSmoke({ page, check, waitFor });
    // A reload can retain work from the smoke sequence until GC. Use a fresh
    // context so it cannot masquerade as idle editor work or a memory leak.
    await page.context().close();
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on("pageerror", (error) => failures.push(error.message));
  }
  await page.goto(
    `${origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html`,
    { waitUntil: "networkidle" },
  );
  await page
    .locator(
      '[data-design-frame="home.html"] iframe[data-design-document-buffer="displayed"][data-design-document-ready]',
    )
    .waitFor();
  await page.waitForTimeout(2000);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  await cdp.send("HeapProfiler.collectGarbage");
  const metrics = async () =>
    Object.fromEntries(
      (await cdp.send("Performance.getMetrics")).metrics.map(
        ({ name, value }) => [name, value],
      ),
    );
  const samples = [];
  for (let index = 0; index < 3; index += 1) {
    const before = await metrics();
    await page.waitForTimeout(3000);
    const after = await metrics();
    samples.push({
      idleSeconds: after.Timestamp - before.Timestamp,
      rendererTaskSeconds: after.TaskDuration - before.TaskDuration,
      rendererScriptSeconds: after.ScriptDuration - before.ScriptDuration,
      layouts: after.LayoutCount - before.LayoutCount,
      jsHeapUsedBytes: after.JSHeapUsedSize,
      jsHeapDeltaBytes: after.JSHeapUsedSize - before.JSHeapUsedSize,
      documents: after.Documents,
      nodes: after.Nodes,
    });
  }
  const report = {
    recordedAt: new Date().toISOString(),
    platform: process.platform,
    architecture: process.arch,
    cpus: os.availableParallelism(),
    cpuModel: os.cpus()[0]?.model,
    hostMemoryBytes: os.totalmem(),
    browser: browser.version(),
    viewport: { width: 1440, height: 900 },
    fixture: "default Design workspace harness",
    smokeRun: !measureOnly,
    method:
      "Fresh browser context, two-second settle, forced GC, three three-second idle windows. Heap is not RSS.",
    samples,
    failures,
    qualification:
      "Linux/Chromium renderer baseline only. Not a native-host, GPU-memory, energy, cloud-worker, or large-document qualification.",
  };
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Baseline: ${output}`);
  if (failures.length) throw new Error(failures.join("\n"));
} finally {
  await browser?.close();
  try {
    process.kill(-vite.pid, "SIGTERM");
  } catch {
    vite.kill("SIGTERM");
  }
}
