import {
  DESIGN_CAPTURE_SHEET_SCHEME,
  DESIGN_STATIC_RENDER_CSS,
  DESIGN_STILL_TIMELINES_SOURCE,
  designCaptureRasterSize,
  type DesignBatchCaptureRequest,
} from "@zeros/protocol/design-capture";
import { insertDesignHeadMarkup, sanitizeDesignFrameMarkup } from "./source";

/** One capture document lays out this many frames at most; more frames per
 * paint stop helping once a sheet's own layout dominates. */
export const DESIGN_CAPTURE_SHEET_ITEMS = 50;
/** A sheet's longest side in device pixels: one bounded compositor surface. */
export const DESIGN_CAPTURE_SHEET_SIDE = 2048;

type BatchItem = DesignBatchCaptureRequest["items"][number];

export interface DesignCaptureSheetCell {
  readonly id: string;
  /** Device-pixel rectangle of this frame's picture within the sheet. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Whole-pixel layout viewport the frame document lays out at. */
  readonly viewport: { readonly width: number; readonly height: number };
}

export interface DesignCaptureSheet {
  /** Device-pixel size of the sheet. */
  readonly width: number;
  readonly height: number;
  readonly cells: readonly DesignCaptureSheetCell[];
}

/** Shelf-packs pictures into bounded sheets in request order, each at the
 * exact raster size a single capture of that frame would produce. */
export function layoutDesignCaptureSheets(
  items: readonly BatchItem[],
  side = DESIGN_CAPTURE_SHEET_SIDE,
  perSheet = DESIGN_CAPTURE_SHEET_ITEMS,
): DesignCaptureSheet[] {
  const sheets: DesignCaptureSheet[] = [];
  let cells: DesignCaptureSheetCell[] = [], x = 0, y = 0, row = 0, width = 0;
  const close = () => {
    if (cells.length) sheets.push({ width, height: y + row, cells });
    cells = []; x = 0; y = 0; row = 0; width = 0;
  };
  for (const item of items) {
    const raster = designCaptureRasterSize(item.viewport, item.maxDimension);
    const cellWidth = Math.min(raster.width, side), cellHeight = Math.min(raster.height, side);
    if (x > 0 && x + cellWidth > side) { x = 0; y += row; row = 0; }
    if (cells.length >= perSheet || (cells.length && y + cellHeight > side)) close();
    cells.push({ id: item.id, x, y, width: raster.width, height: raster.height,
      viewport: { width: Math.ceil(item.viewport.width), height: Math.ceil(item.viewport.height) } });
    x += cellWidth; row = Math.max(row, cellHeight); width = Math.max(width, x);
  }
  close();
  return sheets;
}

/** The capture-only head of a frame document: no authored script can run,
 * only this batch's stylesheets and data: images/fonts can load, and
 * timelines hold their opening state. */
export function designCaptureFramePolicy(colorScheme: "light" | "dark"): string {
  return `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline' ${DESIGN_CAPTURE_SHEET_SCHEME}:; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none';"><style>${DESIGN_STATIC_RENDER_CSS}html{color-scheme:${colorScheme}}</style>`;
}

const attribute = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

/** A host-authored document holding one sheet's frames. Each frame is a
 * sandboxed srcdoc document (no scripts) at its own layout viewport, scaled
 * so it paints its exact picture rectangle at `devicePixelRatio`. */
export function designCaptureSheetDocument(
  sheet: DesignCaptureSheet,
  items: ReadonlyMap<string, BatchItem>,
  colorScheme: "light" | "dark",
  devicePixelRatio: number,
): string {
  const ratio = devicePixelRatio > 0 ? devicePixelRatio : 1;
  const policy = designCaptureFramePolicy(colorScheme);
  const cells = sheet.cells.map((cell) => {
    const item = items.get(cell.id);
    if (!item) throw new Error("Design capture sheet lost an item.");
    const html = insertDesignHeadMarkup(sanitizeDesignFrameMarkup(item.html), policy);
    const scale = cell.width / (cell.viewport.width * ratio);
    return `<div data-cell="${attribute(cell.id)}" style="position:absolute;overflow:hidden;left:${cell.x / ratio}px;top:${cell.y / ratio}px;width:${cell.width / ratio}px;height:${cell.height / ratio}px">` +
      `<iframe sandbox="allow-same-origin" srcdoc="${attribute(html)}" style="position:absolute;left:0;top:0;border:0;width:${cell.viewport.width}px;height:${cell.viewport.height}px;transform:scale(${scale});transform-origin:0 0"></iframe></div>`;
  }).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;overflow:hidden;background:transparent}</style></head><body>${cells}</body></html>`;
}

/** Host-evaluated in a loaded sheet: every frame document is complete, its
 * fonts and images are decoded, its timelines are still, and two frames
 * have painted. Resolves to the number of frames whose documents loaded. */
export const DESIGN_CAPTURE_SHEET_READY_SCRIPT = `(async () => {
  const frames = Array.from(document.querySelectorAll("iframe"));
  await Promise.all(frames.map(frame => frame.contentDocument && frame.contentDocument.readyState === "complete" ? null :
    new Promise(resolve => frame.addEventListener("load", resolve, { once: true }))));
  const still = (function (document) { ${DESIGN_STILL_TIMELINES_SOURCE}; return stillAuthoredTimelines; });
  await Promise.all(frames.map(frame => {
    const document = frame.contentDocument;
    if (!document) return null;
    try { still(document)(); } catch (_error) {}
    return Promise.all([document.fonts.ready, ...Array.from(document.images, image => image.decode().catch(() => {}))]);
  }));
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  return frames.filter(frame => frame.contentDocument).length;
})()`;
