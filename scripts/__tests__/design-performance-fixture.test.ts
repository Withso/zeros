import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { chromium, type Browser } from "@playwright/test";
import { readDesignFrame, readDesignWorkspaceSnapshot } from "../../apps/desktop/src/engine/design/document";

it("generates real Local images and transparent text in the authored renderer", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "zeros-native-fixture-test-"));
  const workspace = path.join(temporary, "checkout");
  let browser: Browser | undefined;
  try {
    await promisify(execFile)(process.execPath, ["--import", "tsx", "scripts/design-performance-fixture.ts", "--frames", "2", "--mixed", "--output", workspace], { timeout: 30_000 });
    const snapshot = await readDesignWorkspaceSnapshot(workspace);
    expect(snapshot.frames).toHaveLength(2);
    expect(snapshot.frames.map(frame => frame.kind)).toEqual(["frame", "text"]);
    const frame = await readDesignFrame(workspace, snapshot.frames[0]!.file);
    expect(frame.srcDoc).toMatch(/<img[^>]+src="data:image\/png;base64,/);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.setContent(frame.srcDoc);
    const sizes = await page.evaluate(async () => {
      await Promise.all([...document.images].map((image) => image.decode()));
      return [...document.images].map((image) => [image.naturalWidth, image.naturalHeight]);
    });
    expect(sizes).toEqual([[24, 24], [24, 24], [24, 24]]);
    const text = await readDesignFrame(workspace, snapshot.frames[1]!.file);
    await page.setContent(text.srcDoc);
    expect(await page.locator("body").innerText()).toContain("Native transparent text");
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
  } finally {
    await browser?.close();
    await rm(temporary, { force: true, recursive: true });
  }
}, 35_000);

it("holds visible complexity constant when fixed-view fixtures add distant frames", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "zeros-fixed-view-test-"));
  try {
    const workspace = path.join(temporary, "checkout");
    await promisify(execFile)(process.execPath, ["--import", "tsx", "scripts/design-performance-fixture.ts", "--frames", "32", "--layout", "fixed-view", "--output", workspace], { timeout: 30_000 });
    const snapshot = await readDesignWorkspaceSnapshot(workspace);
    expect(snapshot.frames).toHaveLength(32);
    // The camera uses the same first two frames at every fixture size. Neither
    // the visible rectangle nor overscan may acquire extra rows as N grows.
    const near = snapshot.frames.filter(frame => frame.x < 10_000 && frame.y < 10_000);
    expect(near).toHaveLength(2);
    expect(near.map(({ x, y, width, height }) => ({ x, y, width, height }))).toEqual([
      { x: 0, y: 0, width: 560, height: 360 },
      { x: 640, y: 0, width: 560, height: 360 },
    ]);
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
}, 35_000);
