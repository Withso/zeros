/** Exact-source macOS qualification. Bundle with esbuild (electron and native
 * modules external) and run with the pinned development Electron runtime. */
import { strict as assert } from "node:assert";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { endianness, tmpdir } from "node:os";
import path from "node:path";
import { app, BrowserWindow, nativeImage } from "electron";
import { startElectronDesignCapture } from "../apps/desktop/electron/design-capture";
import { setDesignCaptureConfig } from "../apps/desktop/src/engine/design/capture-client";
import { initializeDesignDocument, createDesignFrame } from "../apps/desktop/src/engine/design/document";
import { designDirectoryNameFor } from "../apps/desktop/src/engine/design/directory-registry";
import { createDesignContextReference } from "../apps/desktop/src/engine/design/context";
import { startDesignVerificationService } from "../apps/desktop/src/engine/design/verification-service";
import { runDesignVerificationCli } from "../apps/desktop/src/engine/design/verification-cli";
import { resolveCodexNativeBrowserRuntime } from "../apps/desktop/src/engine/agents/adapters/codex/browser-tools";
import { startZerosBrowserService } from "../apps/desktop/electron/browser/service";
import { encodeCodexBrowserUseFrame } from "../apps/desktop/electron/codex-browser-use-pipe";

async function nativeRequest<T>(pipe: string, method: string, params: Record<string, unknown>): Promise<T> {
  const socket = createConnection(pipe);
  try {
    await once(socket, "connect");
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Native Browser timed out: ${method}`)), 15_000);
      let buffer = Buffer.alloc(0);
      socket.once("error", reject);
      socket.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length < 4) return;
        const length = endianness() === "LE" ? buffer.readUInt32LE(0) : buffer.readUInt32BE(0);
        if (buffer.length < length + 4) return;
        clearTimeout(timer);
        const response = JSON.parse(buffer.subarray(4, length + 4).toString());
        if (response.error) reject(new Error(response.error.message));
        else resolve(response.result);
      });
      socket.write(encodeCodexBrowserUseFrame({ jsonrpc: "2.0", id: 1, method, params }));
    });
  } finally { socket.destroy(); }
}

app.on("window-all-closed", () => {});
void app.whenReady().then(async () => {
  assert.equal(process.platform, "darwin", "Native qualification requires macOS");
  const root = await mkdtemp(path.join(tmpdir(), "zeros-design-native-source-"));
  const capture = await startElectronDesignCapture();
  setDesignCaptureConfig(capture);
  const verification = await startDesignVerificationService();
  let browser: Awaited<ReturnType<typeof startZerosBrowserService>> | undefined;
  let window: BrowserWindow | undefined;
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    await initializeDesignDocument(root);
    const frame = await createDesignFrame(root, { title: "Phone", geometry: { x: 0, y: 0, w: 390, h: 844, z: 0 } });
    const directory = designDirectoryNameFor(root);
    const file = path.join(root, directory, frame.file);
    await writeFile(file, '<!doctype html><html><head><link rel="stylesheet" href="tokens.css"></head><body><main data-oid="screen">Native Design preview</main><script>document.body.textContent="unsupported script ran"</script></body></html>');
    await writeFile(path.join(root, directory, "tokens.css"), "body{margin:0;background:seagreen;color:white;font:24px system-ui}main{padding:24px}");
    const reference = await createDesignContextReference(root, "native-fixture", frame.file);
    const access = verification.register({ workspaceId: "native-fixture", workspacePath: root, directory, directoryId: reference.directoryId });
    const pngPath = path.join(root, "frame.png");
    const lines: string[] = [];
    assert.equal(await runDesignVerificationCli(["validate", "--url", access.url, "--frame", frame.file], (line) => lines.push(line)), 1);
    assert(JSON.parse(lines.pop()!).report.violations.some((v: { severity: string }) => v.severity === "error"));
    console.log("PASS native shell validation reports unsupported scripts");
    assert.equal(await runDesignVerificationCli(["capture", "--url", access.url, "--frame", frame.file, "--output", pngPath], (line) => lines.push(line)), 0);
    const png = nativeImage.createFromBuffer(await readFile(pngPath));
    assert.deepEqual(png.getSize(), { width: 390, height: 844 });
    assert.equal(BrowserWindow.getAllWindows().length, 0);
    console.log("PASS native PNG is 390 × 844 and capture window is destroyed");

    for (const [width, height, pngWidth, pngHeight] of [[390, 3000, 266, 2048], [390.5, 844.25, 391, 845]]) {
      const sized = await createDesignFrame(root, { title: "Sized", geometry: { w: width, h: height } });
      await writeFile(path.join(root, directory, sized.file), '<style>html,body{margin:0}main{height:100vh;background:lime}@media(min-width:380px){main{background:linear-gradient(red 0 50%,blue 50% 100%)}}</style><main></main>');
      assert.equal(await runDesignVerificationCli(["capture", "--url", access.url, "--frame", sized.file, "--output", pngPath], line => lines.push(line)), 0);
      const sizedPng = nativeImage.createFromBuffer(await readFile(pngPath));
      assert.deepEqual(sizedPng.getSize(), { width: pngWidth, height: pngHeight });
      const pixels = sizedPng.toBitmap();
      const lastRow = (pngHeight - 1) * pngWidth * 4;
      assert.notDeepEqual(pixels.subarray(0, 4), pixels.subarray(lastRow, lastRow + 4), "Scaled capture retains both ends of the responsive frame");
      assert.equal(BrowserWindow.getAllWindows().length, 0);
    }
    console.log("PASS native capture bounds large and fractional frames without reflow or clipping");

    window = new BrowserWindow({ show: false, width: 480, height: 960, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    await window.loadURL(`${access.url}/${frame.file}/?frameId=${reference.frameId}`);
    const ready = async () => {
      for (let attempt = 0; attempt < 50; attempt++) {
        const state = await window!.webContents.executeJavaScript("window.__ZEROS_FRAME_PREVIEW__");
        if (state?.ready) return state;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error("Native HTTP preview did not become ready");
    };
    const state = await ready();
    assert.equal(state.reference.revision, reference.revision);
    const text = await window.webContents.executeJavaScript("document.querySelector('iframe').contentDocument.body.textContent");
    assert.match(text, /Native Design preview/); assert.doesNotMatch(text, /unsupported script ran/);
    console.log("PASS native HTTP preview uses the exact sanitized frame revision");
    await writeFile(file, (await readFile(file, "utf8")).replace("Native Design preview", "Native refreshed preview"));
    for (let attempt = 0; attempt < 70; attempt++) {
      const next = await ready();
      if (next.reference.revision !== reference.revision) break;
      if (attempt === 69) throw new Error("Native preview did not refresh edited source");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    console.log("PASS native preview refreshes saved source");
    window.destroy(); window = undefined;

    const runtime = await resolveCodexNativeBrowserRuntime({ codexCliPath: process.env.ZEROS_QUALIFICATION_CODEX_PATH });
    assert(runtime, "Installed official Browser runtime must be discoverable");
    console.log("PASS installed official Browser runtime and exact skill discovered");
    browser = await startZerosBrowserService({ artifactRoot: path.join(root, "browser-artifacts"), isTrustedSurfaceAvailable: () => true });
    browser.setUiPreferences({ browserEnabled: true, showAgentCursor: false, navigationApproval: "always-ask" });
    const acquired = await browser.acquire({ workspaceId: "native-fixture", conversationId: "qualification", workspaceRoot: root });
    const registered = await fetch(`${browser.baseUrl}/v1/providers/codex/register`, {
      method: "POST", headers: { authorization: `Bearer ${browser.token}`, "content-type": "application/json" },
      body: JSON.stringify({ version: 1, browserSessionId: acquired.browserSessionId, nativeSessionId: "design-qualification" }),
    });
    assert(registered.ok);
    const identity = { session_id: "design-qualification", turn_id: "preview-check" };
    const call = <T>(method: string, params: Record<string, unknown> = {}) => nativeRequest<T>(browser!.codexBrowserUsePipePath, method, { ...identity, ...params });
    assert.equal((await call<{ type: string }>("getInfo")).type, "iab");
    const tab = await call<{ id: number }>("createTab");
    const cdp = <T>(method: string, commandParams: Record<string, unknown>) => call<T>("executeCdp", { target: { tabId: tab.id }, method, commandParams });
    await cdp("Page.navigate", { url: `${access.url}/${frame.file}/?frameId=${reference.frameId}` });
    for (let attempt = 0; attempt < 70; attempt++) {
      const result = await cdp<{ result: { value?: boolean } }>("Runtime.evaluate", { expression: "window.__ZEROS_FRAME_PREVIEW__?.ready === true", returnByValue: true });
      if (result.result.value) break;
      if (attempt === 69) throw new Error("IAB HTTP preview did not become ready");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const screenshot = await cdp<{ data: string }>("Page.captureScreenshot", { format: "png" });
    assert(!nativeImage.createFromBuffer(Buffer.from(screenshot.data, "base64")).isEmpty());
    console.log("PASS registered native IAB opens the HTTP preview and captures pixels");
    // This exercises the host's pinned native contract, not a live model turn
    // or a claim that unified-computer-use has the same IAB implementation.
  } finally {
    window?.destroy(); await browser?.stop(); await verification.stop(); await capture.stop();
    setDesignCaptureConfig(undefined); await rm(root, { recursive: true, force: true });
    app.quit();
  }
}).catch((error) => { console.error(error); app.exit(1); });
