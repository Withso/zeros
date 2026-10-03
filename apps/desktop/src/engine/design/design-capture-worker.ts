/** Cloud image entrypoint, executed as the dedicated capture UID. One bounded
 * source request on stdin, one PNG reply on stdout, then process teardown. */
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

async function main() {
  if (process.platform !== "linux" || process.getuid?.() === 0)
    throw new Error("Capture requires an unprivileged Linux worker.");
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
  if (Buffer.byteLength(input.html) > DESIGN_CAPTURE_HTML_BYTES)
    throw new Error("Capture input too large.");
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
    };
    await context.close();
    process.stdout.write(JSON.stringify(reply));
  } finally {
    await browser.close();
  }
}
// The parent owns the hard deadline/process group. Never print untrusted source
// or raw browser errors (which may contain full data URLs) to an agent-readable log.
main().catch(() => {
  process.exitCode = 1;
});
