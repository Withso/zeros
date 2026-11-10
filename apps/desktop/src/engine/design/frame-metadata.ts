import type { DefaultTreeAdapterTypes } from "parse5";
import { elementRecords } from "./source";
import type {
  CanvasDocument,
  DesignFrameGeometry,
  FrameMeta,
} from "./document-model";

const DEFAULT_FRAME_WIDTH = 1_440;
const DEFAULT_FRAME_HEIGHT = 900;
const FRAME_GRID_GAP = 120;
const FRAME_GRID_COLUMNS = 3;
const FRAME_COORDINATE_LIMIT = 1_000_000;

export function nextFrameGeometry(
  existing: DesignFrameGeometry[],
  meta: { width: number; height: number },
): DesignFrameGeometry {
  const index = existing.length;
  const widest = Math.max(
    meta.width,
    ...existing.map((geometry) => geometry.w),
  );
  const tallest = Math.max(
    meta.height,
    ...existing.map((geometry) => geometry.h),
  );
  // Three columns until the rows would pass the storable coordinate range;
  // very tall canvases then widen the grid instead of leaving it.
  const rows = Math.floor(FRAME_COORDINATE_LIMIT / (tallest + FRAME_GRID_GAP)) + 1;
  const columns = Math.max(FRAME_GRID_COLUMNS, Math.ceil((index + 1) / rows));
  const column = index % columns;
  const row = Math.floor(index / columns);
  return {
    x: Math.min(FRAME_COORDINATE_LIMIT, column * (widest + FRAME_GRID_GAP)),
    y: Math.min(FRAME_COORDINATE_LIMIT, row * (tallest + FRAME_GRID_GAP)),
    w: meta.width,
    h: meta.height,
    z: index,
  };
}

/** A duplicate sits beside its original, like a design tool's copy: to the
 * right at the same top, past every frame already in that space. The grid
 * slot for the next new frame ignores where frames were moved and can land
 * the copy on top of other work. */
export function duplicateFrameGeometry(
  original: DesignFrameGeometry,
  existing: DesignFrameGeometry[],
  meta: { width: number; height: number },
): DesignFrameGeometry {
  const y = original.y;
  let x = original.x + original.w + FRAME_GRID_GAP;
  // Each pass moves past at least one frame, so this ends within one pass per frame.
  for (let pass = 0; pass <= existing.length; pass += 1) {
    const blocking = existing.filter((frame) =>
      x < frame.x + frame.w && frame.x < x + meta.width &&
      y < frame.y + frame.h && frame.y < y + meta.height);
    if (!blocking.length) break;
    x = Math.max(...blocking.map((frame) => frame.x + frame.w)) + FRAME_GRID_GAP;
  }
  return {
    x: Math.min(FRAME_COORDINATE_LIMIT, x),
    y: Math.min(FRAME_COORDINATE_LIMIT, y),
    w: meta.width,
    h: meta.height,
    z: existing.length,
  };
}

export function readFrameMeta(
  document: DefaultTreeAdapterTypes.Document,
  file: string,
  canvas?: CanvasDocument,
): FrameMeta {
  let content = "";
  for (const { element } of elementRecords(document)) {
    if (element.tagName !== "meta") continue;
    const name = element.attrs.find((attribute) => attribute.name === "name");
    if (name?.value !== "zeros-frame") continue;
    content =
      element.attrs.find((attribute) => attribute.name === "content")?.value ??
      "";
    break;
  }
  const numberValue = (key: string, fallback: number): number => {
    const match = new RegExp(`(?:^|,)\\s*${key}\\s*=\\s*([0-9.]+)`, "i").exec(
      content,
    );
    const value = match ? Number(match[1]) : fallback;
    return Number.isFinite(value)
      ? Math.min(16_384, Math.max(1, value))
      : fallback;
  };
  const titleMatch = /(?:^|,)\s*title\s*=\s*(.+)$/i.exec(content);
  const kindMatch = /(?:^|,)\s*kind\s*=\s*(frame|text)(?:\s*,|\s*$)/i.exec(
    content,
  );
  return {
    title:
      canvas?.frame_info[file]?.title ||
      titleMatch?.[1]?.trim().slice(0, 120) ||
      elementRecords(document)
        .find(({ element }) => element.tagName === "title")
        ?.element.childNodes.map((node) => ("value" in node ? node.value : ""))
        .join("")
        .trim()
        .slice(0, 120) ||
      file.replace(/\.html$/i, "").replace(/[-_]+/g, " "),
    width: canvas?.frames[file]?.w ?? numberValue("width", DEFAULT_FRAME_WIDTH),
    height:
      canvas?.frames[file]?.h ?? numberValue("height", DEFAULT_FRAME_HEIGHT),
    kind:
      canvas?.frame_info[file]?.kind ??
      (kindMatch?.[1]?.toLowerCase() === "text" ? "text" : "frame"),
  };
}
