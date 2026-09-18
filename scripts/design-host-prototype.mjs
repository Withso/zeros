#!/usr/bin/env node
// Development qualification only. No product surface or executable document
// format is enabled by this probe. Native Electron hosting needs its own run.
import assert from "node:assert/strict";
import http from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { Worker } from "node:worker_threads";
import { chromium } from "@playwright/test";

const results = [];
const server = http.createServer((request, response) => {
  response.setHeader("Content-Type", "text/html");
  if (request.url === "/blocked") response.setHeader("X-Frame-Options", "DENY");
  response.end(
    '<!doctype html><title>Design host fixture</title><button id="target">Focus fixture</button>',
  );
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
let worker;
try {
  browser = await chromium.launch({ headless: true });
  const first = await browser.newContext();
  const second = await browser.newContext();
  await first.addCookies([{ name: "owner", value: "first", url: origin }]);
  const page = await first.newPage();
  await page.goto(origin);
  await page.evaluate(() => localStorage.setItem("owner", "first"));
  const peer = await second.newPage();
  await peer.goto(origin);
  assert.equal((await second.cookies()).length, 0);
  assert.equal(await peer.evaluate(() => localStorage.getItem("owner")), null);
  results.push({
    check:
      "separate browser contexts isolate same-origin cookies and local storage",
    passed: true,
  });

  await page.evaluate(() => {
    const frame = document.createElement("iframe");
    frame.id = "embedded";
    frame.src = "/";
    document.body.append(frame);
  });
  await page.frameLocator("#embedded").locator("#target").waitFor();
  const child = page.frames().find((frame) => frame.parentFrame());
  assert.equal(
    await child.evaluate(() => localStorage.getItem("owner")),
    "first",
  );
  results.push({
    check:
      "a DOM iframe shares its owning context storage; it is not a separate session",
    passed: true,
  });

  const deniedNavigation = page.waitForEvent("requestfailed", {
    predicate: (request) => request.url() === `${origin}/blocked`,
    timeout: 5_000,
  });
  await page.evaluate(() => {
    const frame = document.createElement("iframe");
    frame.id = "denied";
    frame.src = "/blocked";
    document.body.append(frame);
  });
  assert.ok((await deniedNavigation).failure());
  assert.equal(
    await page.frameLocator("#denied").locator("#target").count(),
    0,
  );
  results.push({
    check: "ordinary iframe embedding cannot promise arbitrary URL support",
    passed: true,
  });

  await peer.locator("#target").focus();
  assert.equal(
    await peer
      .locator("#target")
      .evaluate((node) => node === document.activeElement),
    true,
  );
  const capture = await peer.screenshot({ type: "png" });
  assert.deepEqual(
    [...capture.subarray(0, 8)],
    [137, 80, 78, 71, 13, 10, 26, 10],
  );
  await second.close();
  assert.equal(peer.isClosed(), true);
  assert.equal(browser.contexts().length, 1);
  await first.close();
  assert.equal(browser.contexts().length, 0);
  results.push({
    check: "isolated context focus, capture, and owner teardown",
    passed: true,
    pngBytes: capture.length,
  });

  // A separate JS worker can be terminated even when its authored program
  // never yields. This proves neither DOM/GPU isolation nor an OS CPU quota.
  worker = new Worker(
    'const {parentPort}=require("node:worker_threads"); parentPort.postMessage("running"); for (;;) {}',
    {
      eval: true,
      resourceLimits: {
        maxOldGenerationSizeMb: 16,
        maxYoungGenerationSizeMb: 4,
        stackSizeMb: 1,
      },
    },
  );
  await new Promise((resolve, reject) => {
    worker.once("message", resolve);
    worker.once("error", reject);
  });
  const started = performance.now();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const heartbeatMs = performance.now() - started;
  const stopStarted = performance.now();
  await worker.terminate();
  const terminationMs = performance.now() - stopStarted;
  worker = null;
  assert.ok(heartbeatMs < 2_000);
  assert.ok(terminationMs < 2_000);
  results.push({
    check:
      "a non-yielding worker leaves the host responsive and can be terminated",
    passed: true,
    heartbeatMs,
    terminationMs,
  });
  await mkdir(".context", { recursive: true });
  const report = {
    platform: process.platform,
    architecture: process.arch,
    browser: browser.version(),
    recordedAt: new Date().toISOString(),
    results,
    qualification:
      "Chromium context and Node worker prototype only. Does not qualify Electron WebContentsView transforms/overlays, macOS energy/GPU/RSS, arbitrary tool execution, production browser packaging, or cloud placement.",
  };
  await writeFile(
    ".context/design-host-prototype.json",
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await worker?.terminate();
  await browser?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
