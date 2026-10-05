import type { DesignPageSummary } from "@zeros/protocol/design-pages";
import type { CanvasDocument } from "./document-model";

/** Derive a read catalog without adding enumerable state to legacy documents
 * (pending transaction journals hash their exact internal JSON shape). */
export function designCanvasPageCatalog(
  canvas: CanvasDocument,
  legacyFiles: string[] = Object.keys(canvas.frames),
  paged = false,
): DesignPageSummary[] {
  if (!paged) return [{
    id: canvas.pages?.[0]?.id ?? "main",
    title: canvas.pages?.[0]?.title ?? "Design",
    folder: "",
    frameFiles: [...new Set([...Object.keys(canvas.frames), ...legacyFiles])],
  }];
  const fileById = new Map(Object.entries(canvas.frame_info).map(([file, info]) => [info.id, file]));
  return (canvas.pages ?? []).map((page) => ({
    id: page.id,
    title: page.title,
    folder: page.folder!,
    frameFiles: page.frames.map((id) => {
      const file = fileById.get(id);
      if (!file) throw new Error("Design page references an unknown frame.");
      return file;
    }),
  }));
}
