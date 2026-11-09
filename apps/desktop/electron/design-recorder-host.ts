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
import { rmSync } from "node:fs";
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
import { DESIGN_CAPTURE_FRAME_CSP, designCaptureFramePolicy } from "../src/engine/design/capture-sheet";
import { insertDesignHeadMarkup, sanitizeDesignFrameMarkup } from "../src/engine/design/source";
import { designRecorderFrameGuard } from "./design-recorder-frame";
import { DESIGN_RECORDER_PREPARE_SCRIPT } from "./design-recorder-scripts";
import { externalizeRecordedLayer, RecordedTypefaceIds } from "./design-recorder-typefaces";

const token = process.env.ZEROS_DESIGN_RECORDER_TOKEN ?? "";
delete process.env.ZEROS_DESIGN_RECORDER_TOKEN;
const recorder = process.env.ZEROS_DESIGN_RECORDER_IDENTITY ?? "";
delete process.env.ZEROS_DESIGN_RECORDER_IDENTITY;
const WINDOWS = Math.max(1, Math.min(4, Number(process.env.ZEROS_DESIGN_RECORDER_WINDOWS) || Math.floor((os.availableParallelism?.() ?? os.cpus().length) / 2)));
const MAX_BODY_BYTES = 64 * 1024 * 1024;
/** Batches the recorder takes at once; their frames share the windows. */
const MAX_BATCHES = 3;
/** Diagnostics: a JSON-lines file of each frame's step durations. */
const TIMINGS = process.env.ZEROS_DESIGN_RECORDER_TIMINGS ?? "";
delete process.env.ZEROS_DESIGN_RECORDER_TIMINGS;

/** A window's page process keeps growing with the documents it lays out
 * (past 1.2 GB after ~250 frames in the app on a Mac); after this many frames
 * the window is replaced, which returns its process's memory. */
const FRAMES_PER_WINDOW = Math.max(1, Number(process.env.ZEROS_DESIGN_RECORDER_FRAMES_PER_WINDOW) || 64);

interface Slot {
  readonly window: BrowserWindow;
  /** Resolves with a reason once the page crashes or the window is destroyed. */
  readonly gone: Promise<string>;
  ratio: number;
  /** Frames this window has recorded. */
  frames: number;
  /** Emulation already applied, so an unchanged frame skips the round trip. */
  viewport?: string;
  colorScheme?: string;
}

app.commandLine.appendSwitch("enable-gpu-benchmarking");
// Each frame is its own navigation; a page kept for back/forward would only
// hold memory, since nothing here ever goes back.
app.commandLine.appendSwitch("disable-features", "BackForwardCache");
protocol.registerSchemesAsPrivileged([{
  scheme: DESIGN_CAPTURE_SHEET_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: false, stream: false, corsEnabled: false },
}]);
app.on("window-all-closed", () => {});
/** This session's pictures and fonts; nothing in it outlives the process. */
let sessionRoot: string | null = null;
// The parent holds this pipe open for this process's whole life. app.exit
// skips will-quit, so the session's folder is removed here, synchronously.
const exit = () => {
  if (sessionRoot) try { rmSync(sessionRoot, { recursive: true, force: true }); } catch { /* the parent removes it on exit */ }
  app.exit(0);
};
process.stdin.on("end", exit);
process.stdin.on("error", exit);
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
    // The header holds whatever the document's own markup does before its policy meta tag.
    if (html !== undefined) return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
      "Content-Security-Policy": DESIGN_CAPTURE_FRAME_CSP } });
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
  // A crashed page leaves its window and contents in place, so a step waiting
  // on it would never settle: both ends count.
  const gone = new Promise<string>((resolve) => {
    window.webContents.once("render-process-gone", (_event, details) =>
      resolve(`The recorder's page stopped (${details.reason}) while recording this frame.`));
    window.webContents.once("destroyed", () => resolve("Design recorder document was destroyed."));
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  await window.loadURL("about:blank");
  window.webContents.debugger.attach("1.3");
  await window.webContents.debugger.sendCommand("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });
  const ratio = Number(await window.webContents.executeJavaScript("devicePixelRatio"));
  return { window, gone, ratio: Number.isFinite(ratio) && ratio > 0 ? ratio : 1, frames: 0 };
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
const typefaceIds = new RecordedTypefaceIds();

async function recordItem(slot: Slot, documents: Map<string, string>, item: DesignBatchRecordRequest["items"][number],
  colorScheme: "light" | "dark", folder: string, typefaceFolder: string, signal: AbortSignal): Promise<DesignBatchRecordReply["items"][number]> {
  const guard = designRecorderFrameGuard({ gone: slot.gone, signal });
  const whileAlive = guard.run;
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
      // EXPERIMENT: show the whole page zoomed far out, so the hidden window rasters tiny tiles; layout and the recorded picture are unchanged.
      await whileAlive(contents.debugger.sendCommand("Emulation.setDeviceMetricsOverride",
        { width: item.viewport.width, height: item.viewport.height, deviceScaleFactor: slot.ratio, mobile: false,
          viewport: { x: 0, y: 0, width: item.viewport.width, height: item.viewport.height, scale: 0.05 } }));
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
    guard.signal.throwIfAborted();
    await whileAlive(contents.executeJavaScript(DESIGN_STATIC_RENDER_SCRIPT));
    step("still");
    await whileAlive(contents.executeJavaScript(DESIGN_RECORDER_PREPARE_SCRIPT));
    step("prepare");
    guard.signal.throwIfAborted();
    const directory = path.join(folder, item.id);
    await mkdir(directory, { mode: 0o700 });
    await whileAlive(contents.executeJavaScript(`chrome.gpuBenchmarking.printToSkPicture(${JSON.stringify(directory)})`));
    step("print");
    const layers = (await whileAlive(readdir(directory))).filter((name) => /^layer_\d+\.skp$/.test(name));
    // Only a recorded frame's folder is handed to the engine, which removes it.
    if (layers.length === 0) { await rm(directory, { recursive: true, force: true }); return { id: item.id, error: "The recorder produced no picture for this frame." }; }
    // Without positions for extra layers the picture would be incomplete;
    // such a frame keeps its bitmap preview instead.
    if (layers.length > 1) {
      const sizes = await Promise.all(layers.map(async (name) => pictureSize(path.join(directory, name))));
      await rm(directory, { recursive: true, force: true });
      return { id: item.id, permanent: true,
        error: `This frame paints on ${layers.length} composited layers (${sizes.join(", ")}), so it isn't recorded.`.slice(0, 500) };
    }
    const picture = path.join(directory, layers[0]!);
    const { typefaces } = await whileAlive(externalizeRecordedLayer(picture, typefaceFolder, typefacesWritten, typefaceIds));
    step("externalize");
    if (TIMINGS) void appendFile(TIMINGS, `${JSON.stringify({ id: item.id, ...steps })}\n`).catch(() => {});
    return { id: item.id, scale: slot.ratio, layers: [{ x: 0, y: 0, width: Math.round(item.viewport.width * slot.ratio),
      height: Math.round(item.viewport.height * slot.ratio), path: picture, typefaces }] };
  } finally {
    guard.dispose();
    documents.delete(key);
  }
}

void app.whenReady().then(async () => {
  app.dock?.hide();
  const root = await mkdtemp(path.join(os.tmpdir(), DESIGN_RECORDER_FOLDER_PREFIX));
  sessionRoot = root;
  const typefaceFolder = path.join(root, "typefaces");
  await mkdir(typefaceFolder, { mode: 0o700 });
  const { partition, documents, stylesheets } = isolatedPartition();
  const idle: Slot[] = [];
  const acquire = async () => {
    const slot = idle.pop();
    return slot && !slot.window.isDestroyed() ? slot : createSlot(partition);
  };
  // Batches share one queue of frames that every window drains, so a batch's
  // last slow frame no longer idles the other windows, and the next batch's
  // frames start as soon as a window is free.
  interface Batch {
    readonly colorScheme: "light" | "dark";
    readonly folder: string;
    readonly signal: AbortSignal;
    readonly results: Map<string, DesignBatchRecordReply["items"][number]>;
    readonly pending: Set<string>;
    answered: boolean;
    done(): void;
  }
  const jobs: Array<{ item: DesignBatchRecordRequest["items"][number]; batch: Batch }> = [];
  const stylesheetUsers = new Map<string, number>();
  let windowsWorking = 0;
  let batches = 0;
  const finish = (batch: Batch, id: string, result: DesignBatchRecordReply["items"][number] | null) => {
    // A frame finishing after its batch answered left files nobody will read.
    if (batch.answered) { void rm(path.join(batch.folder, id), { recursive: true, force: true }).catch(() => {}); return; }
    if (result) batch.results.set(id, result);
    batch.pending.delete(id);
    if (!batch.pending.size) batch.done();
  };
  const work = async () => {
    for (let job = jobs.shift(); job; job = jobs.shift()) {
      const { item, batch } = job;
      if (batch.signal.aborted) { finish(batch, item.id, null); continue; }
      let slot: Slot | null = null;
      try {
        slot = await acquire();
        finish(batch, item.id, await recordItem(slot, documents, item, batch.colorScheme, batch.folder, typefaceFolder, batch.signal));
      } catch (error) {
        // A failed frame keeps no window or files: the next one starts clean.
        if (slot && !slot.window.isDestroyed()) slot.window.destroy();
        slot = null;
        await rm(path.join(batch.folder, item.id), { recursive: true, force: true }).catch(() => {});
        finish(batch, item.id, { id: item.id, error: (error instanceof Error ? error.message : String(error)).slice(0, 500) || "Design recording failed." });
      } finally {
        if (slot) {
          if (++slot.frames >= FRAMES_PER_WINDOW) slot.window.destroy();
          else idle.push(slot);
        }
      }
    }
  };
  const pump = () => {
    while (windowsWorking < WINDOWS && jobs.length) {
      windowsWorking++;
      void work().finally(() => { windowsWorking--; pump(); });
    }
  };
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
    if (batches >= MAX_BATCHES) { fail(429, "The recorder is busy."); return; }
    batches++;
    const controller = new AbortController();
    // At the deadline the frames already recorded are still answered; the
    // rest fail. A disconnected caller gets nothing.
    const timedOut = new Error("Design recording timed out.");
    const timeout = setTimeout(() => controller.abort(timedOut), DESIGN_BATCH_CAPTURE_TIMEOUT_MS);
    response.once("close", () => { if (!response.writableEnded) controller.abort(new Error("Design recording disconnected.")); });
    void (async () => {
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
        for (const [hash, css] of Object.entries(input.stylesheets)) {
          stylesheets.set(hash, css);
          stylesheetUsers.set(hash, (stylesheetUsers.get(hash) ?? 0) + 1);
        }
        const folder = path.join(root, randomUUID());
        await mkdir(folder, { mode: 0o700 });
        const results = new Map<string, DesignBatchRecordReply["items"][number]>();
        let done!: () => void;
        const finished = new Promise<void>((resolve) => { done = resolve; });
        const batch: Batch = { colorScheme: input.colorScheme, folder, signal: controller.signal, results,
          pending: new Set(input.items.map((item) => item.id)), answered: false, done };
        for (const item of input.items) jobs.push({ item, batch });
        pump();
        const stopped = new Promise<void>((resolve) => {
          if (controller.signal.aborted) resolve();
          else controller.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        await Promise.race([finished, stopped]);
        batch.answered = true;
        // Frames of this batch still queued are dropped; frames in flight stop at their guard.
        for (let index = jobs.length - 1; index >= 0; index--) if (jobs[index]!.batch === batch) jobs.splice(index, 1);
        if (controller.signal.aborted && controller.signal.reason !== timedOut) throw controller.signal.reason;
        const unfinished = controller.signal.aborted ? timedOut.message : "Design recording was cancelled.";
        response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        response.end(JSON.stringify({ recorder, items: input.items.map((item) => results.get(item.id) ?? { id: item.id, error: unfinished }) }));
      } catch {
        if (!response.destroyed && !response.headersSent) fail(422, "Design recording failed.");
      } finally {
        clearTimeout(timeout);
        // A stylesheet stays while another batch's frames still use it.
        if (input) for (const hash of Object.keys(input.stylesheets)) {
          const users = (stylesheetUsers.get(hash) ?? 1) - 1;
          if (users > 0) stylesheetUsers.set(hash, users);
          else { stylesheetUsers.delete(hash); stylesheets.delete(hash); }
        }
        batches--;
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
