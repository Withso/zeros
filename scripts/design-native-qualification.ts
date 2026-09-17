/** Runs with the development Electron binary on macOS. Build with esbuild
 * (electron external), then execute with Electron; never load the product UI. */
import {
  app,
  BrowserWindow,
  BaseWindow,
  WebContentsView,
  session,
  nativeImage,
} from "electron";
import { createServer } from "node:http";
import { writeFile, mkdir } from "node:fs/promises";
import { startElectronDesignCapture } from "../apps/desktop/electron/design-capture";

app.on("window-all-closed", () => {});
async function main() {
  if (process.platform !== "darwin")
    throw new Error("Native Design qualification requires macOS.");
  await app.whenReady();
  const checks: string[] = [];
  const hostRestrictions: string[] = [];
  const assert = (ok: unknown, label: string) => {
    if (!ok) throw new Error(label);
    checks.push(label);
    console.log("PASS", label);
  };
  const delay = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));
  const metrics = () =>
    app.getAppMetrics().map((metric) => ({
      type: metric.type,
      memory: metric.memory,
      cpu: metric.cpu,
    }));
  const initialMetrics = metrics();
  let networkReads = 0;
  const network = createServer((_request, response) => {
    networkReads++;
    response.setHeader("Content-Type", "text/html");
    response.end(
      '<html><body><button id="target">Focus</button></body></html>',
    );
  });
  await new Promise<void>((resolve) => network.listen(0, "127.0.0.1", resolve));
  const address = network.address();
  if (!address || typeof address === "string")
    throw new Error("Test server did not bind.");
  const origin = `http://127.0.0.1:${address.port}`;
  const capture = await startElectronDesignCapture();
  const request = (signal?: AbortSignal) =>
    fetch(`${capture.url}/capture`, {
      method: "POST",
      signal,
      headers: {
        Authorization: `Bearer ${capture.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        version: 1,
        revision: "native-source-1",
        width: 320,
        height: 240,
        html: `<html><head><style>body{margin:0;background:red}</style></head><body><img src="${origin}/external"><script>document.body.style.background='blue';fetch('${origin}/script')</script></body></html>`,
      }),
    });
  const started = performance.now();
  try {
    const response = await request();
    if (!response.ok)
      throw new Error(
        `Native capture failed: ${response.status} ${await response.text()}`,
      );
    const reply = await response.json();
    const image = nativeImage.createFromBuffer(
      Buffer.from(reply.data, "base64"),
    );
    assert(
      image.getSize().width === 320 && image.getSize().height === 240,
      "PNG uses exact CSS viewport dimensions on Retina hardware",
    );
    const pixels = image.toBitmap();
    const pixel = (100 * 320 + 100) * 4;
    assert(
      pixels[pixel + 2] === 255 && pixels[pixel] === 0,
      "Authored scripts cannot change the captured pixels",
    );
    assert(
      networkReads === 0,
      "External image and script requests are blocked",
    );
    assert(
      BrowserWindow.getAllWindows().length === 0,
      "Capture releases its hidden window without an attached renderer",
    );
    for (const colorScheme of ["light", "dark"] as const) {
      const mediaResponse = await fetch(`${capture.url}/capture`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${capture.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          version: 1,
          revision: `media-${colorScheme}`,
          width: 320,
          height: 240,
          colorScheme,
          html: `<style>body{margin:0;height:100vh;box-sizing:border-box;background:red}@media(prefers-color-scheme:dark){body{background:blue}}@media(prefers-reduced-motion:reduce){body{border-left:160px solid lime}}</style><body></body>`,
        }),
      });
      if (!mediaResponse.ok) throw new Error("Media capture failed.");
      const mediaReply = await mediaResponse.json();
      const mediaPixels = nativeImage
        .createFromBuffer(Buffer.from(mediaReply.data, "base64"))
        .toBitmap();
      const motionPixel = (100 * 320 + 10) * 4;
      const themePixel = (100 * 320 + 250) * 4;
      assert(
        mediaPixels[motionPixel + 1] === 255 &&
          mediaPixels[motionPixel] === 0 &&
          mediaPixels[themePixel + (colorScheme === "light" ? 2 : 0)] === 255 &&
          mediaPixels[themePixel + (colorScheme === "light" ? 0 : 2)] === 0,
        `Native capture honors ${colorScheme} media and reduced motion`,
      );
    }
    const concurrent = await Promise.all([request(), request(), request()]);
    assert(
      concurrent.filter((result) => result.status === 200).length === 1 &&
        concurrent.filter((result) => result.status === 429).length === 2,
      "Native capture enforces one global render slot",
    );
    for (const result of concurrent) await result.body?.cancel();
    const abort = new AbortController();
    const pending = request(abort.signal).catch((error) => error);
    for (
      let attempt = 0;
      attempt < 100 && BrowserWindow.getAllWindows().length === 0;
      attempt++
    )
      await delay(2);
    abort.abort();
    await pending;
    for (
      let attempt = 0;
      attempt < 100 && BrowserWindow.getAllWindows().length;
      attempt++
    )
      await delay(10);
    assert(
      BrowserWindow.getAllWindows().length === 0,
      "Client cancellation destroys the in-flight native window",
    );
    await delay(50);
    assert((await request()).ok, "Capture recovers after cancellation");
  } finally {
    await capture.stop();
  }

  const parent = new BaseWindow({
    show: false,
    focusable: false,
    width: 640,
    height: 480,
  });
  const views = [0, 1].map(
    (index) =>
      new WebContentsView({
        webPreferences: {
          session: session.fromPartition(
            `design-native-probe-${process.pid}-${index}`,
          ),
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      }),
  );
  const contents = views.map((view) => view.webContents);
  try {
    for (const [index, view] of views.entries()) {
      parent.contentView.addChildView(view);
      view.setBounds({ x: index * 320, y: 0, width: 320, height: 240 });
      await view.webContents.loadURL(origin);
    }
    await contents[0]!.executeJavaScript(
      "localStorage.setItem('probe','first')",
    );
    assert(
      (await contents[1]!.executeJavaScript(
        "localStorage.getItem('probe')",
      )) === null,
      "Native browser hosts own separate storage partitions",
    );
    views[0]!.setBounds({ x: 24, y: 32, width: 240, height: 180 });
    assert(
      views[0]!.getBounds().x === 24 && views[0]!.getBounds().width === 240,
      "Native host supports explicit canvas rectangle updates",
    );
    views[0]!.setVisible(false);
    assert(
      !views[0]!.getVisible(),
      "Native host can be hidden for an app overlay",
    );
    views[0]!.setVisible(true);
    assert(
      (await contents[0]!.executeJavaScript(
        "document.getElementById('target').focus();document.activeElement.id",
      )) === "target",
      "Focus remains inside the selected native document",
    );
    try {
      const screenshot = await contents[0]!.capturePage(undefined, {
        stayHidden: true,
      });
      if (screenshot.isEmpty()) throw new Error("Empty native capture");
      assert(true, "Hidden native view supports capture");
    } catch {
      hostRestrictions.push(
        "A fully hidden WebContentsView cannot reliably capture on this host. Use the qualified dedicated authored capture window.",
      );
    }
    void contents[1]!.executeJavaScript("while(true){}").catch(() => {});
    const responsiveAt = performance.now();
    await delay(100);
    assert(
      performance.now() - responsiveAt < 1000,
      "Non-yielding guest JavaScript does not block the native host timer",
    );
    contents[1]!.forcefullyCrashRenderer();
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Hung native host did not close")),
        5000,
      );
      contents[1]!.once("destroyed", () => {
        clearTimeout(timeout);
        resolve();
      });
      contents[1]!.close({ waitForBeforeUnload: false });
    });
    assert(
      contents[1]!.isDestroyed(),
      "Native host can retire a hung guest renderer",
    );
  } finally {
    for (const content of contents)
      if (!content.isDestroyed()) content.close({ waitForBeforeUnload: false });
    parent.destroy();
    await new Promise<void>((resolve) => network.close(() => resolve()));
  }
  await delay(1000);
  const idleStart = {
    wall: performance.now(),
    cpu: process.cpuUsage(),
    metrics: metrics(),
  };
  await delay(60_000);
  const idleCpu = process.cpuUsage(idleStart.cpu);
  const idle = {
    seconds: (performance.now() - idleStart.wall) / 1000,
    mainCpuSeconds: (idleCpu.user + idleCpu.system) / 1_000_000,
    windows: BrowserWindow.getAllWindows().length,
    beforeMetrics: idleStart.metrics,
    afterMetrics: metrics(),
  };
  assert(
    idle.windows === 0,
    "Closed capture retains no native windows after 60 seconds",
  );
  const report = {
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    chromium: process.versions.chrome,
    checkedAt: new Date().toISOString(),
    elapsedMs: performance.now() - started,
    checks,
    hostRestrictions,
    initialMetrics,
    idle,
    finalMetrics: metrics(),
    limitations: [
      "Hidden fixture windows; this does not certify OS keyboard interaction in the product shell.",
      "Native rectangles do not establish arbitrary CSS rotation/clipping or web-platform parity.",
      "Idle CPU is measured for the main process over 60 seconds; OS energy impact and GPU allocation require separate profiling.",
    ],
  };
  await mkdir(".context", { recursive: true });
  await writeFile(
    ".context/design-native-qualification.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
}
main().then(
  () => app.exit(0),
  (error) => {
    console.error(error);
    app.exit(1);
  },
);
