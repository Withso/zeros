import { chromium, type Browser } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createDesignFrame, initializeDesignDocument } from "../document";
import { createDesignContextReference } from "../context";
import { designDirectoryNameFor, forgetDesignDirectoryName } from "../directory-registry";
import { startDesignVerificationService } from "../verification-service";
import { CloudRuntimePreviewGateway } from "../../transport/cloud-preview-gateway";

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

it.each(["local", "cloud"])("opens a %s static sandboxed frame offscreen, then refreshes saved source while visible", async placement => {
  const root = await mkdtemp(path.join(tmpdir(), "zeros-frame-preview-browser-"));
  const service = await startDesignVerificationService({ renderer: () => undefined });
  const page = await browser.newPage();
  let gateway: CloudRuntimePreviewGateway | undefined;
  let server: Server | undefined;
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    await initializeDesignDocument(root);
    const frame = (await createDesignFrame(root, { title: "Phone", geometry: { x: 0, y: 0, w: 390, h: 844, z: 0 } })).file;
    const directory = designDirectoryNameFor(root);
    const file = path.join(root, directory, frame);
    const source = '<html><head><link rel="stylesheet" href="../tokens.css"></head><body><main data-oid="screen">Phone</main><script>document.body.textContent="script ran"</script></body></html>';
    await writeFile(file, source);
    await writeFile(path.join(root, directory, "tokens.css"), "body{margin:0}main{width:100%;height:100vh;color:var(--color-brand);opacity:1;animation:fade 1s infinite alternate}@keyframes fade{from{opacity:0}to{opacity:0.5}}");
    await mkdir(path.join(root, "styles"));
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
    await writeFile(path.join(root, "styles/dot.png"), Buffer.from(png, "base64"));
    await writeFile(path.join(root, "styles/app.css"), '@import "tailwindcss"; @theme { --color-brand: rebeccapurple; } main { background-image: url(./dot.png); }');
    const canvasFile = path.join(root, directory, "meta/canvas.json");
    const canvas = JSON.parse(await readFile(canvasFile, "utf8"));
    canvas.styles = [{ id: "app", kind: "tailwind", path: "styles/app.css" }];
    await writeFile(canvasFile, JSON.stringify(canvas));
    const reference = await createDesignContextReference(root, "workspace", frame);
    const access = service.register({ workspaceId: "workspace", workspacePath: root, directory, directoryId: reference.directoryId });
    const destination = new URL(`${access.url}/${frame}/?frameId=${reference.frameId}`);
    if (placement === "cloud") {
      const remotePort = Number(destination.port);
      const credential = `zwp_${"A".repeat(43)}`;
      gateway = new CloudRuntimePreviewGateway({
        forbiddenPorts: () => [],
        verify: async token => token === credential ? {
          version: 1, audience: "zeros-cloud-runtime-access-admission-v1", admitted: true,
          grantId: "11111111-1111-4111-8111-111111111111", accountUserId: "22222222-2222-4222-8222-222222222222",
          authorityEpoch: 1, kind: "preview", remotePort, expiresAtMs: Date.now() + 10_000,
        } : null,
      });
      server = createServer((req, res) => {
        if (!gateway!.handle(req, res)) { res.statusCode = 404; res.end(); }
      });
      await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
      destination.port = String((server.address() as { port: number }).port);
      // The public ingress cannot expose the listener without admission. The
      // native Browser service supplies the grant for its exact frame target.
      expect((await fetch(destination)).status).toBe(404);
      expect((await fetch(destination, { headers: { "x-zeros-runtime-access": `zwp_${"B".repeat(43)}` } })).status).toBe(401);
      await page.setExtraHTTPHeaders({ "x-zeros-runtime-access": credential });
    }
    // The native browser parks its view offscreen until the user opens its tab.
    await page.addInitScript(() => Object.defineProperty(document, "hidden", { get: () => true, configurable: true }));
    await page.goto(destination.toString());
    await page.waitForFunction(() => (window as unknown as { __ZEROS_FRAME_PREVIEW__: { ready: boolean } }).__ZEROS_FRAME_PREVIEW__?.ready, undefined, { timeout: 2000 });
    const rendered = await page.locator("iframe").evaluate(async (element: HTMLIFrameElement) => {
      const doc = element.contentDocument!;
      const style = doc.defaultView!.getComputedStyle(doc.querySelector("main")!);
      const referenceColor = doc.createElement("span");
      referenceColor.style.color = "rebeccapurple";
      doc.body.append(referenceColor);
      const colorMatches = style.color === doc.defaultView!.getComputedStyle(referenceColor).color;
      referenceColor.remove();
      const image = doc.createElement("img");
      image.src = style.backgroundImage.slice(5, -2);
      await image.decode();
      return { width: element.clientWidth, height: element.clientHeight, text: doc.body.textContent, opacity: style.opacity, animations: doc.getAnimations().length,
        colorMatches, backgroundImage: style.backgroundImage, imageWidth: image.naturalWidth };
    });
    expect(rendered).toEqual({ width: 390, height: 844, text: "Phone", opacity: "1", animations: 0,
      colorMatches: true, backgroundImage: `url("data:image/png;base64,${png}")`, imageWidth: 1 });
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
    await page.close();
    gateway?.close();
    if (server) {
      server.closeAllConnections();
      await new Promise<void>(resolve => server!.close(() => resolve()));
    }
    await service.stop(); forgetDesignDirectoryName(root); await rm(root, { recursive: true, force: true });
  }
});

it("keeps the seeded tokens.css reset below an imported Tailwind source's utilities", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zeros-frame-reset-layer-"));
  const service = await startDesignVerificationService({ renderer: () => undefined });
  const page = await browser.newPage();
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    // The seed (and every directory created before this fix) declares
    // `@layer reset`; it must never outrank the application's utilities.
    await initializeDesignDocument(root);
    const frame = (await createDesignFrame(root, { title: "Buttons", geometry: { x: 0, y: 0, w: 390, h: 844, z: 0 } })).file;
    const directory = designDirectoryNameFor(root);
    expect(await readFile(path.join(root, directory, "tokens.css"), "utf8")).toContain("@layer reset");
    await writeFile(
      path.join(root, directory, frame),
      '<!doctype html><html><head><link rel="stylesheet" href="../tokens.css"></head><body style="font-size:20px;font-weight:400;color:darkgreen"><main data-oid="screen"><h1 data-oid="title" class="mt-4">Title</h1><button data-oid="go" class="text-sm font-bold text-brand">Go</button></main></body></html>',
    );
    await mkdir(path.join(root, "styles"));
    await writeFile(path.join(root, "styles/app.css"), '@import "tailwindcss"; @theme { --color-brand: rebeccapurple; }');
    const canvasFile = path.join(root, directory, "meta/canvas.json");
    const canvas = JSON.parse(await readFile(canvasFile, "utf8"));
    canvas.styles = [{ id: "app", kind: "tailwind", path: "styles/app.css" }];
    await writeFile(canvasFile, JSON.stringify(canvas));
    const reference = await createDesignContextReference(root, "workspace", frame);
    const access = service.register({ workspaceId: "workspace", workspacePath: root, directory, directoryId: reference.directoryId });
    await page.goto(`${access.url}/${frame}/?frameId=${reference.frameId}`);
    await page.waitForFunction(() => (window as unknown as { __ZEROS_FRAME_PREVIEW__: { ready: boolean } }).__ZEROS_FRAME_PREVIEW__?.ready, undefined, { timeout: 5000 });
    const computed = await page.locator("iframe").evaluate((element: HTMLIFrameElement) => {
      const doc = element.contentDocument!;
      const view = doc.defaultView!;
      const button = view.getComputedStyle(doc.querySelector("button")!);
      const reference = doc.createElement("span");
      reference.style.color = "rebeccapurple";
      doc.body.append(reference);
      const brand = view.getComputedStyle(reference).color;
      reference.remove();
      return {
        buttonColorIsBrand: button.color === brand,
        buttonFontSize: button.fontSize,
        buttonFontWeight: button.fontWeight,
        headingMarginTop: view.getComputedStyle(doc.querySelector("h1")!).marginTop,
      };
    });
    expect(computed).toEqual({
      buttonColorIsBrand: true,
      buttonFontSize: "14px",
      buttonFontWeight: "700",
      headingMarginTop: "16px",
    });
  } finally {
    await page.close(); await service.stop(); forgetDesignDirectoryName(root); await rm(root, { recursive: true, force: true });
  }
});
