/** Cloud image entrypoint, executed as the non-root engine user. One bounded
 * source request on stdin, one PNG reply on stdout, then process teardown. */
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import {
  DESIGN_CAPTURE_HTML_BYTES,
  DESIGN_CAPTURE_TIMEOUT_MS,
  DESIGN_STATIC_RENDER_CSS,
  designCaptureRequestSchema,
} from "@zeros/protocol/design-capture";
import { sanitizeDesignFrameMarkup, insertDesignHeadMarkup } from "./source";
import { assertDesignCapturePng } from "./capture-service";
import { prepareDesignCaptureViewport, captureScaledDesignPng } from "./capture-viewport";

export async function captureCloudDesignFrame(input: ReturnType<typeof designCaptureRequestSchema.parse>) {
  if (process.platform !== "linux" || process.geteuid?.() !== 10003 || process.getegid?.() !== 10003)
    throw new Error("Capture requires the fixed non-root engine capture identity.");
  if (Buffer.byteLength(input.html) > DESIGN_CAPTURE_HTML_BYTES)
    throw new Error("Capture input too large.");
  const identity = { uid: process.geteuid(), gid: process.getegid() };
  return render(input, identity);
}

async function main() {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > DESIGN_CAPTURE_HTML_BYTES + 1024 * 1024)
      throw new Error("Capture input too large.");
    chunks.push(Buffer.from(chunk));
  }
  const input = designCaptureRequestSchema.parse(
    JSON.parse(Buffer.concat(chunks).toString("utf8")),
  );
  process.stdout.write(JSON.stringify(await captureCloudDesignFrame(input)));
}

async function render(input: ReturnType<typeof designCaptureRequestSchema.parse>, identity: { uid: number; gid: number }) {
  const browser = await chromium.launch({
    headless: true,
    chromiumSandbox: true,
    timeout: DESIGN_CAPTURE_TIMEOUT_MS,
  });
  try {
    const context = await browser.newContext({
      viewport: { width: input.width, height: input.height },
      deviceScaleFactor: 1,
      colorScheme: input.colorScheme,
      reducedMotion: "reduce",
      javaScriptEnabled: false,
      offline: true,
      serviceWorkers: "block",
      acceptDownloads: false,
      locale: "en-US",
      timezoneId: "UTC",
    });
    await context.route("**/*", (route) => route.abort("blockedbyclient"));
    const page = await context.newPage();
    const debuggerSession = input.layoutViewport ? await context.newCDPSession(page) : null;
    if (debuggerSession) await prepareDesignCaptureViewport(input, params => debuggerSession.send("Emulation.setDeviceMetricsOverride", params));
    page.setDefaultTimeout(DESIGN_CAPTURE_TIMEOUT_MS);
    // The scaled CDP path supplies the still styles itself; ordinary captures
    // retain Playwright's existing animation handling below.
    const stillStyles = input.layoutViewport ? `<style>${DESIGN_STATIC_RENDER_CSS}</style>` : "";
    const html = insertDesignHeadMarkup(
      sanitizeDesignFrameMarkup(input.html),
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none';">${stillStyles}`,
    );
    await page.setContent(html, { waitUntil: "load" });
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all(
        Array.from(document.images, (image) => image.decode().catch(() => {})),
      );
    });
    const bytes = debuggerSession ? await captureScaledDesignPng(input, params => debuggerSession.send("Page.captureScreenshot", params)) : await page.screenshot({
      type: "png",
      animations: "disabled",
      caret: "hide",
      fullPage: false,
      scale: "css",
    });
    assertDesignCapturePng(bytes, input.width, input.height);
    const reply = {
      data: bytes.toString("base64"),
      renderer: `chromium-${browser.version()}/playwright-1.59.1`,
      identity,
    };
    await context.close();
    return reply;
  } finally {
    await browser.close();
  }
}
// The parent owns the hard deadline/process group. Never print untrusted source
// or raw browser errors (which may contain full data URLs) to an agent-readable log.
const entrypoint = typeof require !== "undefined" && typeof module !== "undefined"
  ? require.main === module
  : !!process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (entrypoint) {
  void main().catch(() => { process.exitCode = 1; });
}
