// The Design recorder: a separate Electron instance that records frames as
// Skia pictures for the recorded canvas. It runs as its own process because
// recording uses chrome.gpuBenchmarking.printToSkPicture, which needs
// --enable-gpu-benchmarking and a renderer allowed to write the pictures to
// disk (unsandboxed). Neither ever applies to the app's own renderers.
//
// What a recorder window loads: one sanitized frame document at a time, from
// this process's private scheme, behind a leading script-src 'none' policy;
// its partition loads nothing else, has no permissions and stores nothing.
// The host evaluates readiness and flattening itself. The parent (the app's
// main process) owns this process: it starts it with a one-time token, talks
// to it over loopback HTTP, and its exit (stdin closing) ends this one.
import { app, BrowserWindow, protocol, session, type Session } from "electron";
import { createServer } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { appendFile, mkdir, mkdtemp, open, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DESIGN_BATCH_CAPTURE_TIMEOUT_MS,
  DESIGN_CAPTURE_SHEET_SCHEME,
  DESIGN_RECORDER_FOLDER_PREFIX,
  DESIGN_STATIC_RENDER_SCRIPT,
  designBatchRecordRequestSchema,
  type DesignBatchRecordReply,
  type DesignBatchRecordRequest,
} from "@zeros/protocol/design-capture";
import { designCaptureFramePolicy } from "../src/engine/design/capture-sheet";
import { insertDesignHeadMarkup, sanitizeDesignFrameMarkup } from "../src/engine/design/source";
import { DESIGN_RECORDER_PREPARE_SCRIPT } from "./design-recorder-scripts";
import { externalizeRecordedLayer } from "./design-recorder-typefaces";

const token = process.env.ZEROS_DESIGN_RECORDER_TOKEN ?? "";
delete process.env.ZEROS_DESIGN_RECORDER_TOKEN;
const recorder = process.env.ZEROS_DESIGN_RECORDER_IDENTITY ?? "";
delete process.env.ZEROS_DESIGN_RECORDER_IDENTITY;
const WINDOWS = Math.max(1, Math.min(4, Number(process.env.ZEROS_DESIGN_RECORDER_WINDOWS) || Math.floor((os.availableParallelism?.() ?? os.cpus().length) / 2)));
const MAX_BODY_BYTES = 64 * 1024 * 1024;
/** Diagnostics: a JSON-lines file of each frame's step durations. */
const TIMINGS = process.env.ZEROS_DESIGN_RECORDER_TIMINGS ?? "";
delete process.env.ZEROS_DESIGN_RECORDER_TIMINGS;

interface Slot {
  readonly window: BrowserWindow;
  readonly retired: Promise<void>;
  ratio: number;
  /** Emulation already applied, so an unchanged frame skips the round trip. */
  viewport?: string;
  colorScheme?: string;
}

app.commandLine.appendSwitch("enable-gpu-benchmarking");
protocol.registerSchemesAsPrivileged([{
  scheme: DESIGN_CAPTURE_SHEET_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: false, stream: false, corsEnabled: false },
}]);
app.on("window-all-closed", () => {});
// The parent holds this pipe open for this process's whole life.
process.stdin.on("end", () => app.exit(0));
process.stdin.on("error", () => app.exit(0));
process.stdin.resume();

function isolatedPartition(): { partition: Session; documents: Map<string, string>; stylesheets: Map<string, string> } {
  const partition = session.fromPartition(`zeros-design-recorder-${randomUUID()}`, { cache: false });
  partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  partition.setPermissionCheckHandler(() => false);
  partition.on("will-download", (event) => event.preventDefault());
  partition.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !details.url.startsWith("data:") && details.url !== "about:blank" && !details.url.startsWith(`${DESIGN_CAPTURE_SHEET_SCHEME}://`) });
  });
  const documents = new Map<string, string>();
  const stylesheets = new Map<string, string>();
  partition.protocol.handle(DESIGN_CAPTURE_SHEET_SCHEME, (request) => {
    const url = new URL(request.url);
    const key = url.pathname.slice(1);
    const css = url.hostname === "css" ? stylesheets.get(key) : undefined;
    if (css !== undefined) return new Response(css, { headers: { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "max-age=31536000, immutable" } });
    const html = url.hostname === "sheet" ? documents.get(key) : undefined;
    if (html !== undefined) return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
    return new Response("", { status: 404 });
  });
  return { partition, documents, stylesheets };
}

async function createSlot(partition: Session): Promise<Slot> {
  const window = new BrowserWindow({
    show: false, focusable: false, skipTaskbar: true, width: 64, height: 64, useContentSize: true,
    webPreferences: {
      session: partition,
      // printToSkPicture writes each layer's picture to disk from the renderer.
      sandbox: false,
      contextIsolation: true, nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
      javascript: true, webSecurity: true, webviewTag: false, backgroundThrottling: false, safeDialogs: true, devTools: false, spellcheck: false,
    },
  });
  const retired = new Promise<void>((resolve) => { window.webContents.once("destroyed", () => resolve()); });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  await window.loadURL("about:blank");
  window.webContents.debugger.attach("1.3");
  await window.webContents.debugger.sendCommand("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });
  const ratio = Number(await window.webContents.executeJavaScript("devicePixelRatio"));
  return { window, retired, ratio: Number.isFinite(ratio) && ratio > 0 ? ratio : 1 };
}

/** A picture's size from its header (SkPictInfo: magic, version, cull rect). */
async function pictureSize(file: string): Promise<string> {
  const handle = await open(file, "r");
  try {
    const header = Buffer.alloc(28);
    await handle.read(header, 0, 28, 0);
    const width = header.readFloatLE(20) - header.readFloatLE(12), height = header.readFloatLE(24) - header.readFloatLE(16);
    return `${Math.round(width)}×${Math.round(height)}`;
  } catch {
    return "?";
  } finally {
    await handle.close();
  }
}

/** Font data written this session, by content id: one file each. */
const typefacesWritten = new Set<string>();

async function recordItem(slot: Slot, documents: Map<string, string>, item: DesignBatchRecordRequest["items"][number],
  colorScheme: "light" | "dark", folder: string, typefaceFolder: string, signal: AbortSignal): Promise<DesignBatchRecordReply["items"][number]> {
  const whileAlive = <T>(operation: Promise<T>): Promise<T> => Promise.race([
    operation,
    slot.retired.then(() => { throw signal.reason ?? new Error("Design recorder document was destroyed."); }),
  ]);
  const key = randomUUID();
  documents.set(key, insertDesignHeadMarkup(sanitizeDesignFrameMarkup(item.html), designCaptureFramePolicy(colorScheme)));
  const contents = slot.window.webContents;
  const steps: Record<string, number> = {};
  let mark = performance.now();
  const step = (name: string) => { const now = performance.now(); steps[name] = Math.round((now - mark) * 10) / 10; mark = now; };
  try {
    // The frame lays out at its own viewport whatever the window's size.
    const viewport = `${item.viewport.width}x${item.viewport.height}`;
    if (slot.viewport !== viewport) {
      await whileAlive(contents.debugger.sendCommand("Emulation.setDeviceMetricsOverride",
        { width: item.viewport.width, height: item.viewport.height, deviceScaleFactor: slot.ratio, mobile: false }));
      slot.viewport = viewport;
    }
    if (slot.colorScheme !== colorScheme) {
      await whileAlive(contents.debugger.sendCommand("Emulation.setEmulatedMedia", {
        media: "screen", features: [{ name: "prefers-color-scheme", value: colorScheme }, { name: "prefers-reduced-motion", value: "reduce" }],
      }));
      slot.colorScheme = colorScheme;
    }
    step("emulate");
    await whileAlive(slot.window.loadURL(`${DESIGN_CAPTURE_SHEET_SCHEME}://sheet/${key}`));
    step("load");
    signal.throwIfAborted();
    await whileAlive(contents.executeJavaScript(DESIGN_STATIC_RENDER_SCRIPT));
    step("still");
    await whileAlive(contents.executeJavaScript(DESIGN_RECORDER_PREPARE_SCRIPT));
    step("prepare");
    signal.throwIfAborted();
    const directory = path.join(folder, item.id);
    await mkdir(directory, { mode: 0o700 });
    await whileAlive(contents.executeJavaScript(`chrome.gpuBenchmarking.printToSkPicture(${JSON.stringify(directory)})`));
    step("print");
    const layers = (await readdir(directory)).filter((name) => /^layer_\d+\.skp$/.test(name));
    if (layers.length === 0) return { id: item.id, error: "The recorder produced no picture for this frame." };
    // Without positions for extra layers the picture would be incomplete;
    // such a frame keeps its bitmap preview instead.
    if (layers.length > 1) {
      const sizes = await Promise.all(layers.map(async (name) => pictureSize(path.join(directory, name))));
      return { id: item.id, error: `This frame paints on ${layers.length} composited layers (${sizes.join(", ")}), so it is shown as a picture.`.slice(0, 500) };
    }
    const picture = path.join(directory, layers[0]!);
    const { typefaces } = await externalizeRecordedLayer(picture, typefaceFolder, typefacesWritten);
    step("externalize");
    if (TIMINGS) void appendFile(TIMINGS, `${JSON.stringify({ id: item.id, ...steps })}\n`).catch(() => {});
    return { id: item.id, scale: slot.ratio, layers: [{ x: 0, y: 0, width: Math.round(item.viewport.width * slot.ratio),
      height: Math.round(item.viewport.height * slot.ratio), path: picture, typefaces }] };
  } finally {
    documents.delete(key);
  }
}

void app.whenReady().then(async () => {
  app.dock?.hide();
  const root = await mkdtemp(path.join(os.tmpdir(), DESIGN_RECORDER_FOLDER_PREFIX));
  const typefaceFolder = path.join(root, "typefaces");
  await mkdir(typefaceFolder, { mode: 0o700 });
  const { partition, documents, stylesheets } = isolatedPartition();
  const idle: Slot[] = [];
  const acquire = async () => {
    const slot = idle.pop();
    return slot && !slot.window.isDestroyed() ? slot : createSlot(partition);
  };
  let busy = false;
  const expected = Buffer.from(`Bearer ${token}`);
  let serviceUrl = "";
  const server = createServer({ maxHeaderSize: 16 * 1024 }, (request, response) => {
    const fail = (status: number, error: string) => {
      response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", Connection: "close" });
      response.end(JSON.stringify({ error }));
    };
    const supplied = Buffer.from(request.headers.authorization ?? "");
    if (token.length !== 64 || request.headers.origin || request.headers.host !== new URL(serviceUrl).host ||
      supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { fail(401, "Unauthorized recorder request."); return; }
    if (request.method !== "POST" || request.url !== "/record") { fail(404, "Unknown recorder operation."); return; }
    if (busy) { fail(429, "The recorder is busy."); return; }
    busy = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("Design recording timed out.")), DESIGN_BATCH_CAPTURE_TIMEOUT_MS);
    response.once("close", () => { if (!response.writableEnded) controller.abort(new Error("Design recording disconnected.")); });
    void (async () => {
      const working = new Set<Slot>();
      let input: DesignBatchRecordRequest | null = null;
      try {
        let size = 0;
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          size += chunk.length;
          if (size > MAX_BODY_BYTES) { fail(413, "Recording input is too large."); return; }
          chunks.push(Buffer.from(chunk));
        }
        input = designBatchRecordRequestSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        for (const [hash, css] of Object.entries(input.stylesheets)) stylesheets.set(hash, css);
        const folder = path.join(root, randomUUID());
        await mkdir(folder, { mode: 0o700 });
        const queue = [...input.items];
        const results = new Map<string, DesignBatchRecordReply["items"][number]>();
        await Promise.all(Array.from({ length: Math.min(WINDOWS, queue.length) }, async () => {
          for (let item = queue.shift(); item && !controller.signal.aborted; item = queue.shift()) {
            let slot: Slot | null = null;
            try {
              slot = await acquire();
              working.add(slot);
              results.set(item.id, await recordItem(slot, documents, item, input!.colorScheme, folder, typefaceFolder, controller.signal));
            } catch (error) {
              // A failed frame keeps no window: the next one starts clean.
              if (slot && !slot.window.isDestroyed()) slot.window.destroy();
              slot = null;
              results.set(item.id, { id: item.id, error: (error instanceof Error ? error.message : String(error)).slice(0, 500) || "Design recording failed." });
            } finally {
              if (slot) { working.delete(slot); idle.push(slot); }
            }
          }
        }));
        controller.signal.throwIfAborted();
        response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        response.end(JSON.stringify({ recorder, items: input.items.map((item) => results.get(item.id) ?? { id: item.id, error: "Design recording was cancelled." }) }));
      } catch {
        if (!response.destroyed && !response.headersSent) fail(422, "Design recording failed.");
      } finally {
        clearTimeout(timeout);
        for (const slot of working) if (!slot.window.isDestroyed()) slot.window.destroy();
        if (input) for (const hash of Object.keys(input.stylesheets)) stylesheets.delete(hash);
        busy = false;
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") { app.exit(1); return; }
  serviceUrl = `http://127.0.0.1:${address.port}`;
  app.on("will-quit", () => { void rm(root, { recursive: true, force: true }); });
  process.stdout.write(`ZEROS_DESIGN_RECORDER ${JSON.stringify({ url: serviceUrl, root })}\n`);
});
