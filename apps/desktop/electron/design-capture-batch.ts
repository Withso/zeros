import { BrowserWindow, type Session } from "electron";
import { randomUUID } from "node:crypto";
import os from "node:os";
import { DESIGN_CAPTURE_SHEET_SCHEME } from "@zeros/protocol/design-capture";
import type { DesignBatchCaptureHost } from "../src/engine/design/capture-service";
import {
  DESIGN_CAPTURE_SHEET_READY_SCRIPT,
  designCaptureSheetDocument,
  layoutDesignCaptureSheets,
  type DesignCaptureSheet,
} from "../src/engine/design/capture-sheet";
import { rendererProcessOwners } from "./renderer-process-owners";

/** Capture processes rendering sheets at once. Beyond about four the frames'
 * layout competes for the same cores (measured on an M4 under load). */
export const DESIGN_BATCH_CAPTURE_WINDOWS = Math.max(1, Math.min(4, Math.floor((os.availableParallelism?.() ?? os.cpus().length) / 2)));
/** Idle capture processes are destroyed after this long: a burst of batches
 * reuses them, and a quiet app keeps none. */
export const DESIGN_BATCH_CAPTURE_IDLE_MS = 10_000;

interface Slot {
  readonly window: BrowserWindow;
  /** Resolves when the window's contents are destroyed. */
  readonly retired: Promise<void>;
  ratio: number;
}

/** Renders thumbnail batches in a small pool of hidden, sandboxed capture
 * windows that share the capture partition. A sheet document lays out many
 * frames (sandboxed srcdoc documents, scripts disabled) and one capture of it
 * yields every frame's picture. Stylesheets and sheet documents are served
 * only from the batch being rendered; the partition still loads nothing else. */
export function createElectronDesignBatchCapture(partition: Session, options: {
  windows?: number;
  idleMs?: number;
} = {}): DesignBatchCaptureHost & { retire(): void; usage(): { windows: number; idle: number } } {
  const limit = Math.max(1, options.windows ?? DESIGN_BATCH_CAPTURE_WINDOWS);
  const idleMs = options.idleMs ?? DESIGN_BATCH_CAPTURE_IDLE_MS;
  const documents = new Map<string, string>();
  const stylesheets = new Map<string, string>();
  partition.protocol.handle(DESIGN_CAPTURE_SHEET_SCHEME, (request) => {
    const url = new URL(request.url);
    const key = url.pathname.slice(1);
    const css = url.hostname === "css" ? stylesheets.get(key) : undefined;
    if (css !== undefined)
      return new Response(css, { headers: { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "max-age=31536000, immutable" } });
    const html = url.hostname === "sheet" ? documents.get(key) : undefined;
    if (html !== undefined)
      return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
    return new Response("", { status: 404 });
  });
  const idle: Slot[] = [];
  const all = new Set<Slot>();
  let retireTimer: ReturnType<typeof setTimeout> | null = null;

  const destroy = (slot: Slot) => {
    all.delete(slot);
    const index = idle.indexOf(slot);
    if (index >= 0) idle.splice(index, 1);
    if (!slot.window.isDestroyed()) slot.window.destroy();
  };
  const retire = () => {
    if (retireTimer !== null) clearTimeout(retireTimer);
    retireTimer = null;
    for (const slot of [...idle]) destroy(slot);
    if (!all.size) void partition.clearStorageData();
  };
  const create = async (): Promise<Slot> => {
    const window = new BrowserWindow({
      show: false, focusable: false, skipTaskbar: true, width: 64, height: 64, useContentSize: true,
      webPreferences: {
        session: partition, sandbox: true, contextIsolation: true, nodeIntegration: false,
        nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
        // The host evaluates readiness in its own sheet document. Frames are
        // sandboxed srcdoc documents without allow-scripts, behind a leading
        // script-src 'none' policy, after engine and host sanitization.
        javascript: true, webSecurity: true, webviewTag: false, backgroundThrottling: false,
        safeDialogs: true, devTools: false, spellcheck: false,
      },
    });
    rendererProcessOwners.track(window.webContents, "Design capture");
    const retired = new Promise<void>((resolve) => { window.webContents.once("destroyed", () => resolve()); });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.webContents.on("will-attach-webview", (event) => event.preventDefault());
    const slot: Slot = { window, retired, ratio: 1 };
    all.add(slot);
    try {
      await window.loadURL("about:blank");
      window.webContents.debugger.attach("1.3");
      // The native window's default canvas is opaque; keep authored alpha.
      await window.webContents.debugger.sendCommand("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });
      const ratio = Number(await window.webContents.executeJavaScript("devicePixelRatio"));
      slot.ratio = Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
      return slot;
    } catch (error) {
      destroy(slot);
      throw error;
    }
  };
  const acquire = async (): Promise<Slot> => {
    if (retireTimer !== null) clearTimeout(retireTimer);
    retireTimer = null;
    const slot = idle.pop();
    return slot && !slot.window.isDestroyed() ? slot : create();
  };
  const release = (slot: Slot) => {
    if (slot.window.isDestroyed() || !all.has(slot)) return;
    idle.push(slot);
    if (retireTimer === null) retireTimer = setTimeout(retire, idleMs);
  };

  const renderSheet = async (slot: Slot, sheet: DesignCaptureSheet, html: string, colorScheme: "light" | "dark",
    signal: AbortSignal): Promise<Array<[string, Uint8Array]>> => {
    const whileAlive = <T>(operation: Promise<T>): Promise<T> => Promise.race([
      operation,
      slot.retired.then(() => { throw signal.reason ?? new Error("Design capture document was destroyed."); }),
    ]);
    const token = randomUUID();
    documents.set(token, html);
    try {
      const width = Math.max(1, Math.ceil(sheet.width / slot.ratio)), height = Math.max(1, Math.ceil(sheet.height / slot.ratio));
      slot.window.setContentSize(width, height);
      // Authored prefers-* queries follow this batch's theme, not the OS.
      await whileAlive(slot.window.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", {
        media: "screen", features: [{ name: "prefers-color-scheme", value: colorScheme }, { name: "prefers-reduced-motion", value: "reduce" }],
      }));
      await whileAlive(slot.window.loadURL(`${DESIGN_CAPTURE_SHEET_SCHEME}://sheet/${token}`));
      signal.throwIfAborted();
      await whileAlive(slot.window.webContents.executeJavaScript(DESIGN_CAPTURE_SHEET_READY_SCRIPT));
      signal.throwIfAborted();
      const image = await whileAlive(slot.window.webContents.capturePage({ x: 0, y: 0, width, height }, { stayHidden: true, stayAwake: false }));
      signal.throwIfAborted();
      const scale = image.getSize().width / width;
      return sheet.cells.map((cell) => {
        let picture = image.crop({
          x: Math.round(cell.x * scale / slot.ratio), y: Math.round(cell.y * scale / slot.ratio),
          width: Math.max(1, Math.round(cell.width * scale / slot.ratio)), height: Math.max(1, Math.round(cell.height * scale / slot.ratio)),
        });
        const size = picture.getSize();
        if (size.width !== cell.width || size.height !== cell.height)
          picture = picture.resize({ width: cell.width, height: cell.height, quality: "best" });
        return [cell.id, picture.toPNG()];
      });
    } finally {
      documents.delete(token);
    }
  };

  const renderBatch: DesignBatchCaptureHost = async (input, signal) => {
    signal.throwIfAborted();
    const items = new Map(input.items.map((item) => [item.id, item]));
    const sheets = layoutDesignCaptureSheets(input.items).map((sheet) => ({ sheet, html: new Map<number, string>() }));
    for (const [hash, css] of Object.entries(input.stylesheets)) stylesheets.set(hash, css);
    const results = new Map<string, { id: string; bytes: Uint8Array } | { id: string; error: string }>();
    const queue = [...sheets];
    const working = new Set<Slot>();
    const abort = () => { for (const slot of working) destroy(slot); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      await Promise.all(Array.from({ length: Math.min(limit, sheets.length) }, async () => {
        for (let next = queue.shift(); next && !signal.aborted; next = queue.shift()) {
          let slot: Slot | null = null;
          try {
            slot = await acquire();
            working.add(slot);
            let html = next.html.get(slot.ratio);
            if (html === undefined) next.html.set(slot.ratio, html = designCaptureSheetDocument(next.sheet, items, input.colorScheme, slot.ratio));
            for (const [id, bytes] of await renderSheet(slot, next.sheet, html, input.colorScheme, signal)) results.set(id, { id, bytes });
          } catch (error) {
            // A failed sheet keeps no window: the next sheet starts clean.
            if (slot) destroy(slot);
            slot = null;
            const message = error instanceof Error ? error.message : String(error);
            for (const cell of next.sheet.cells) results.set(cell.id, { id: cell.id, error: message.slice(0, 500) || "Design batch capture failed." });
          } finally {
            if (slot) { working.delete(slot); release(slot); }
          }
        }
      }));
      signal.throwIfAborted();
      return {
        renderer: `electron-${process.versions.electron}/chromium-${process.versions.chrome}`,
        items: input.items.map((item) => results.get(item.id) ?? { id: item.id, error: "Design batch capture did not render this frame." }),
      };
    } finally {
      signal.removeEventListener("abort", abort);
      for (const hash of Object.keys(input.stylesheets)) stylesheets.delete(hash);
    }
  };
  return Object.assign(renderBatch, {
    retire: () => { retire(); for (const slot of [...all]) destroy(slot); },
    usage: () => ({ windows: all.size, idle: idle.length }),
  });
}
