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

export function nextFrameGeometry(
  existing: DesignFrameGeometry[],
  meta: { width: number; height: number },
): DesignFrameGeometry {
  const index = existing.length;
  const column = index % FRAME_GRID_COLUMNS;
  const row = Math.floor(index / FRAME_GRID_COLUMNS);
  const widest = Math.max(
    meta.width,
    ...existing.map((geometry) => geometry.w),
  );
  const tallest = Math.max(
    meta.height,
    ...existing.map((geometry) => geometry.h),
  );
  return {
    x: column * (widest + FRAME_GRID_GAP),
    y: row * (tallest + FRAME_GRID_GAP),
    w: meta.width,
    h: meta.height,
    z: index,
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
