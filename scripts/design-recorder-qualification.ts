/** Native qualification of the Design recorder (macOS). Bundle with esbuild
 * (electron external) and run with the development Electron runtime, after
 * `tsup` has built dist-electron/design-recorder.cjs:
 *
 *   ZEROS_QUALIFY_WORKSPACE=<checkout with a Design directory>
 *   ZEROS_QUALIFY_RECORDER=<dist-electron/design-recorder.cjs>
 *   ZEROS_QUALIFY_CANVASKIT=<folder holding canvaskit.js and canvaskit.wasm>
 *   ZEROS_QUALIFY_OUT=<report folder>
 *   [ZEROS_QUALIFY_PAGES=page-6,page-7] [ZEROS_QUALIFY_DISTINCT=1] [ZEROS_QUALIFY_LIMIT=40]
 *   [ZEROS_QUALIFY_FIXTURES=<frames>]   also writes design.recordings.render replies
 *   electron <bundle> --user-data-dir=<temporary folder>
 *
 * For each frame it renders Chromium's own picture of the unmodified frame in
 * a sandboxed window, records the frame through the real recorder process and
 * client, replays the recording with CanvasKit, and compares pixels. It exits
 * non-zero when a frame differs by more than ZEROS_QUALIFY_MAX_DIFF (0.5%). */
import { app, BrowserWindow, protocol, session } from "electron";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DESIGN_CAPTURE_SHEET_SCHEME,
  DESIGN_STATIC_RENDER_SCRIPT,
} from "@zeros/protocol/design-capture";
import { DESIGN_CAPTURE_RENDERER } from "../apps/desktop/electron/design-capture-batch";
import { createDesignRecorder } from "../apps/desktop/electron/design-recorder";
import { designCaptureFramePolicy } from "../apps/desktop/src/engine/design/capture-sheet";
import { prepareDesignNavigationFrames, readDesignNavigationSnapshot } from "../apps/desktop/src/engine/design/document";
import { readSharedCanvasContext } from "../apps/desktop/src/engine/design/document-storage";
import { designDirectoryNameFor } from "../apps/desktop/src/engine/design/directory-registry";
import { designDirectoryEntry } from "../apps/desktop/src/engine/design/metadata";
import { designBatchRecordRequestFrom, renderDesignRecordings } from "../apps/desktop/src/engine/design/recording-batch";
import { insertDesignHeadMarkup, sanitizeDesignFrameMarkup } from "../apps/desktop/src/engine/design/source";
import { composeDesignThumbnailBatches } from "../apps/desktop/src/engine/design/thumbnail-batch";

const env = process.env;
const WORKSPACE = env.ZEROS_QUALIFY_WORKSPACE!, RECORDER = env.ZEROS_QUALIFY_RECORDER!, CANVASKIT = env.ZEROS_QUALIFY_CANVASKIT!, OUT = env.ZEROS_QUALIFY_OUT!;
const PAGES = (env.ZEROS_QUALIFY_PAGES ?? "").split(",").filter(Boolean);
const LIMIT = Number(env.ZEROS_QUALIFY_LIMIT ?? "40");
const MAX_DIFF = Number(env.ZEROS_QUALIFY_MAX_DIFF ?? "0.005");
const FIXTURES = Number(env.ZEROS_QUALIFY_FIXTURES ?? "0");

protocol.registerSchemesAsPrivileged([{ scheme: DESIGN_CAPTURE_SHEET_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: false, stream: false, corsEnabled: false } }]);
app.on("window-all-closed", () => {});

/** Chromium's own picture of an unmodified frame, as a sandboxed window paints it. */
async function reference(html: string, stylesheets: Record<string, string>, viewport: { width: number; height: number }) {
  const partition = session.fromPartition(`zeros-qualify-${randomUUID()}`, { cache: false });
  const documents = new Map<string, string>();
  partition.protocol.handle(DESIGN_CAPTURE_SHEET_SCHEME, (request) => {
    const url = new URL(request.url); const key = url.pathname.slice(1);
    if (url.hostname === "css" && key in stylesheets) return new Response(stylesheets[key], { headers: { "Content-Type": "text/css; charset=utf-8" } });
    const doc = url.hostname === "sheet" ? documents.get(key) : undefined;
    return doc !== undefined ? new Response(doc, { headers: { "Content-Type": "text/html; charset=utf-8" } }) : new Response("", { status: 404 });
  });
  const window = new BrowserWindow({ show: false, width: 64, height: 64, useContentSize: true,
    webPreferences: { session: partition, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  try {
    await window.loadURL("about:blank");
    const ratio = Number(await window.webContents.executeJavaScript("devicePixelRatio")) || 1;
    window.webContents.debugger.attach("1.3");
    await window.webContents.debugger.sendCommand("Emulation.setDeviceMetricsOverride", { width: viewport.width, height: viewport.height, deviceScaleFactor: ratio, mobile: false });
    await window.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { media: "screen", features: [{ name: "prefers-color-scheme", value: "light" }, { name: "prefers-reduced-motion", value: "reduce" }] });
    await window.webContents.debugger.sendCommand("Emulation.setDefaultBackgroundColorOverride", { color: { r: 255, g: 255, b: 255, a: 1 } });
    const key = randomUUID();
    documents.set(key, insertDesignHeadMarkup(sanitizeDesignFrameMarkup(html), designCaptureFramePolicy("light")));
    await window.loadURL(`${DESIGN_CAPTURE_SHEET_SCHEME}://sheet/${key}`);
    await window.webContents.executeJavaScript(DESIGN_STATIC_RENDER_SCRIPT);
    await window.webContents.executeJavaScript(`Promise.all([document.fonts.ready, ...Array.from(document.images, i => i.decode().catch(() => {}))]).then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))`);
    const shot = await window.webContents.debugger.sendCommand("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    return { png: Buffer.from(shot.data as string, "base64"), ratio };
  } finally {
    window.destroy();
  }
}

/** Share of pixels differing by more than `tolerance` in any channel, and how many sit in flat areas (not edges). */
function compare(a: Uint8Array, b: Uint8Array, width: number, height: number, tolerance = 24) {
  let differing = 0, flat = 0;
  const lum = (d: Uint8Array, i: number) => 0.299 * d[i]! + 0.587 * d[i + 1]! + 0.114 * d[i + 2]!;
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
    const i = (y * width + x) * 4;
    if (Math.max(Math.abs(a[i]! - b[i]!), Math.abs(a[i + 1]! - b[i + 1]!), Math.abs(a[i + 2]! - b[i + 2]!)) <= tolerance) continue;
    differing++;
    let lo = 255, hi = 0;
    for (let j = -1; j <= 1; j++) for (let k = -1; k <= 1; k++) { const l = lum(a, ((y + j) * width + x + k) * 4); lo = Math.min(lo, l); hi = Math.max(hi, l); }
    if (hi - lo < 10) flat++;
  }
  return { share: differing / (width * height), flat };
}

void app.whenReady().then(async () => {
  let failed = false;
  const report: Record<string, unknown> = { renderer: DESIGN_CAPTURE_RENDERER, frames: [] as unknown[] };
  const recorder = createDesignRecorder({ identity: `${DESIGN_CAPTURE_RENDERER}/skp`, entry: RECORDER });
  try {
    await mkdir(OUT, { recursive: true });
    const CanvasKitInit = require(path.join(CANVASKIT, "canvaskit.js"));
    const CK = await CanvasKitInit({ locateFile: (file: string) => path.join(CANVASKIT, file) });
    const directoryId = designDirectoryEntry(WORKSPACE, designDirectoryNameFor(WORKSPACE))!.id;
    const { canvas } = await readSharedCanvasContext(WORKSPACE);
    const design = path.join(WORKSPACE, designDirectoryNameFor(WORKSPACE));
    let files = Object.keys(canvas.frame_info).filter((file) => PAGES.length === 0 || PAGES.some((page) => file.startsWith(`${page}/`))).sort();
    if (env.ZEROS_QUALIFY_DISTINCT === "1") {
      const seen = new Set<number>(); const distinct: string[] = [];
      for (const file of files) { const size = (await stat(path.join(design, file))).size; if (!seen.has(size)) { seen.add(size); distinct.push(file); } }
      files = distinct;
    }
    files = files.slice(0, LIMIT);
    const navigation = await readDesignNavigationSnapshot(WORKSPACE);
    const frames: Array<{ file: string; sourceVersion: string }> = [];
    for (let at = 0; at < files.length; at += 16)
      for (const entry of (await prepareDesignNavigationFrames(WORKSPACE, navigation.catalogRevision, files.slice(at, at + 16))).frames)
        if (entry.sourceVersion) frames.push({ file: entry.file, sourceVersion: entry.sourceVersion });
    let recordedMs = 0, recorded = 0;
    for (let at = 0; at < frames.length; at += 16) {
      const composed = await composeDesignThumbnailBatches(WORKSPACE, { workspaceId: "qualify", directoryId, theme: null, colorScheme: "light", maxDimension: 256, frames: frames.slice(at, at + 16) });
      for (const batch of composed.batches) {
        const request = designBatchRecordRequestFrom(batch.request);
        const started = performance.now();
        const reply = await recorder.record(request, new AbortController().signal);
        recordedMs += performance.now() - started; recorded += request.items.length;
        for (const item of reply.items) {
          const frame = batch.frames.get(item.id)!;
          const source = request.items.find((entry) => entry.id === item.id)!;
          if ("error" in item) { (report.frames as unknown[]).push({ file: frame.file, error: item.error }); console.log(`${frame.file} ERROR ${item.error}`); continue; }
          const bytes = await readFile(item.layers[0]!.path);
          const picture = CK.MakePicture(bytes);
          if (!picture) { failed = true; (report.frames as unknown[]).push({ file: frame.file, error: "CanvasKit could not read the recording." }); continue; }
          const { png, ratio } = await reference(source.html, request.stylesheets, source.viewport);
          const width = Math.round(source.viewport.width * ratio), height = Math.round(source.viewport.height * ratio);
          const decoded = CK.MakeImageFromEncoded(png);
          const surface = CK.MakeSurface(width, height);
          const pixels = (draw: (c: { clear(color: unknown): void; drawPicture(p: unknown): void; drawImage(i: unknown, x: number, y: number): void }) => void) => {
            const c = surface.getCanvas(); c.clear(CK.WHITE); draw(c); surface.flush();
            const image = surface.makeImageSnapshot();
            const out = image.readPixels(0, 0, { width, height, colorType: CK.ColorType.RGBA_8888, alphaType: CK.AlphaType.Unpremul, colorSpace: CK.ColorSpace.SRGB }) as Uint8Array;
            image.delete(); return out;
          };
          const expected = pixels((c) => c.drawImage(decoded, 0, 0));
          const actual = pixels((c) => c.drawPicture(picture));
          const diff = compare(expected, actual, width, height);
          const row = { file: frame.file, bytes: bytes.length, share: diff.share, flatPixels: diff.flat, scale: item.scale };
          (report.frames as unknown[]).push(row);
          if (diff.share > MAX_DIFF) failed = true;
          console.log(`${frame.file} ${(bytes.length / 1024).toFixed(0)} KB diff=${(diff.share * 100).toFixed(3)}% flat=${diff.flat}${diff.share > MAX_DIFF ? "  <-- OVER" : ""}`);
          decoded.delete(); surface.delete(); picture.delete();
        }
      }
    }
    report.recorder = { frames: recorded, ms: Math.round(recordedMs), framesPerSecond: recorded / (recordedMs / 1000) };
    console.log(`recorded ${recorded} frames in ${Math.round(recordedMs)} ms (${(recorded / (recordedMs / 1000)).toFixed(1)} frames/s)`);
    if (FIXTURES > 0) {
      const fixtures = path.join(OUT, "fixtures"); await mkdir(fixtures, { recursive: true });
      const all = Object.keys(canvas.frame_info).filter((file) => PAGES.length === 0 || PAGES.some((page) => file.startsWith(`${page}/`))).sort().slice(0, FIXTURES);
      const known: string[] = [];
      for (let at = 0, index = 0; at < all.length; at += 16, index++) {
        const batch: Array<{ file: string; sourceVersion: string }> = [];
        for (const entry of (await prepareDesignNavigationFrames(WORKSPACE, navigation.catalogRevision, all.slice(at, at + 16))).frames)
          if (entry.sourceVersion) batch.push(entry as { file: string; sourceVersion: string });
        const reply = await renderDesignRecordings(WORKSPACE, { workspaceId: "qualify", directoryId, theme: null, frames: batch, knownChunks: known.slice(-4096) },
          { record: (request, signal) => recorder.record(request, signal ?? new AbortController().signal).then((r) => ({ version: 1 as const, revision: request.revision, ...r })), recorder: `${DESIGN_CAPTURE_RENDERER}/skp` });
        known.push(...reply.chunks.map((chunk) => chunk.id));
        await writeFile(path.join(fixtures, `reply-${String(index).padStart(3, "0")}.json`), JSON.stringify(reply));
      }
      console.log(`wrote fixtures for ${all.length} frames to ${fixtures}`);
    }
  } catch (error) {
    failed = true;
    report.fatal = String((error as Error)?.stack ?? error).slice(0, 2000);
    console.error(report.fatal);
  } finally {
    await recorder.stop();
    await writeFile(path.join(OUT, "recorder-qualification.json"), JSON.stringify(report, null, 2)).catch(() => {});
    app.exit(failed ? 1 : 0);
  }
});
