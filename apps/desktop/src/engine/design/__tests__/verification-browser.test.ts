import { chromium, type Browser } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createDesignFrame, initializeDesignDocument } from "../document";
import { createDesignContextReference } from "../context";
import { designDirectoryNameFor, forgetDesignDirectoryName } from "../directory-registry";
import { startDesignVerificationService } from "../verification-service";

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
afterAll(async () => { await browser?.close(); });

it("blocks authored links and clears readiness if the loaded preview document is replaced", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zeros-frame-navigation-"));
  const service = await startDesignVerificationService({ renderer: () => undefined });
  const page = await browser.newPage();
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    await initializeDesignDocument(root);
    const frame = await createDesignFrame(root, { title: "Phone" });
    const directory = designDirectoryNameFor(root);
    await writeFile(path.join(root, directory, frame.file), '<html><body><main>Phone</main><a href="/">Home</a></body></html>');
    const reference = await createDesignContextReference(root, "workspace", frame.file);
    const access = service.register({ workspaceId: "workspace", workspacePath: root, directory, directoryId: reference.directoryId });
    await page.goto(`${access.url}/${frame.file}/?frameId=${reference.frameId}`);
    const previewReady = () => (window as unknown as { __ZEROS_FRAME_PREVIEW__: { ready: boolean } }).__ZEROS_FRAME_PREVIEW__?.ready;
    await page.waitForFunction(previewReady);
    await page.frameLocator("iframe").getByRole("link", { name: "Home" }).click();
    expect(await page.frameLocator("iframe").locator("main").textContent({ timeout: 1000 })).toBe("Phone");

    // A document load outside the wrapper's render must also invalidate the
    // old evidence, including while visible-only refresh work is paused.
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { get: () => true, configurable: true });
      document.querySelector("iframe")!.src = "/";
    });
    await page.waitForFunction(() => !(window as unknown as { __ZEROS_FRAME_PREVIEW__: { ready: boolean } }).__ZEROS_FRAME_PREVIEW__?.ready, undefined, { timeout: 2000 });
    expect(await page.locator("output").textContent()).toMatch(/replaced|changed|load/i);
    await page.evaluate(() => Object.defineProperty(document, "hidden", { get: () => false }));
    await page.waitForFunction(previewReady);
    expect(await page.frameLocator("iframe").locator("main").textContent()).toBe("Phone");
  } finally {
    await page.close(); await service.stop(); forgetDesignDirectoryName(root); await rm(root, { recursive: true, force: true });
  }
});

it("opens a static sandboxed frame offscreen, then refreshes saved source while visible", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zeros-frame-preview-browser-"));
  const service = await startDesignVerificationService({ renderer: () => undefined });
  const page = await browser.newPage();
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    await initializeDesignDocument(root);
    const frame = (await createDesignFrame(root, { title: "Phone", geometry: { x: 0, y: 0, w: 390, h: 844, z: 0 } })).file;
    const directory = designDirectoryNameFor(root);
    const file = path.join(root, directory, frame);
    const source = '<html><head><link rel="stylesheet" href="tokens.css"></head><body><main data-oid="screen">Phone</main><script>document.body.textContent="script ran"</script></body></html>';
    await writeFile(file, source);
    await writeFile(path.join(root, directory, "tokens.css"), "body{margin:0}main{width:100%;height:100vh;background:seagreen;opacity:1;animation:fade 1s infinite alternate}@keyframes fade{from{opacity:0}to{opacity:0.5}}");
    const reference = await createDesignContextReference(root, "workspace", frame);
    const access = service.register({ workspaceId: "workspace", workspacePath: root, directory, directoryId: reference.directoryId });
    // The native browser parks its view offscreen until the user opens its tab.
    await page.addInitScript(() => Object.defineProperty(document, "hidden", { get: () => true, configurable: true }));
    await page.goto(`${access.url}/${frame}/?frameId=${reference.frameId}`);
    await page.waitForFunction(() => (window as unknown as { __ZEROS_FRAME_PREVIEW__: { ready: boolean } }).__ZEROS_FRAME_PREVIEW__?.ready, undefined, { timeout: 2000 });
    const rendered = await page.locator("iframe").evaluate((element: HTMLIFrameElement) => {
      const doc = element.contentDocument!;
      return { width: element.clientWidth, height: element.clientHeight, text: doc.body.textContent, opacity: doc.defaultView!.getComputedStyle(doc.querySelector("main")!).opacity, animations: doc.getAnimations().length };
    });
    expect(rendered).toEqual({ width: 390, height: 844, text: "Phone", opacity: "1", animations: 0 });
    expect(await readFile(file, "utf8")).toBe(source);
    await page.evaluate(() => Object.defineProperty(document, "hidden", { get: () => false }));
    await writeFile(file, source.replace("Phone</main>", "Updated phone</main>"));
    await page.waitForFunction(() => document.querySelector("iframe")?.contentDocument?.body?.textContent === "Updated phone" &&
      (window as unknown as { __ZEROS_FRAME_PREVIEW__: { ready: boolean } }).__ZEROS_FRAME_PREVIEW__?.ready);
    const updated = await createDesignContextReference(root, "workspace", frame);
    const state = await page.evaluate(() => (window as unknown as { __ZEROS_FRAME_PREVIEW__: unknown }).__ZEROS_FRAME_PREVIEW__);
    expect(state).toMatchObject({ ready: true, width: 390, height: 844, reference: updated });
    service.revoke("workspace");
    await page.waitForFunction(() => !!(window as unknown as { __ZEROS_FRAME_PREVIEW__: { error?: string } }).__ZEROS_FRAME_PREVIEW__?.error);
    expect(await page.locator("output").textContent()).toMatch(/expired/i);
  } finally {
    await page.close(); await service.stop(); forgetDesignDirectoryName(root); await rm(root, { recursive: true, force: true });
  }
});
