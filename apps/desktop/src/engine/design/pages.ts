import {
  designPageIdSchema,
  type DesignPageSummary,
} from "@zeros/protocol/design-pages";
import type {
  CanvasDocument,
  CanvasPage,
  DesignFrameRestorePoint,
} from "./document-model";
import { DesignTargetError } from "./target-error";

/** Explicit target failures must remain visible in prompt/context callers. */
export class DesignPageTargetError extends DesignTargetError {}

export function designPageForWrite(
  canvas: CanvasDocument,
  pageId?: string,
): CanvasPage {
  if (!designPageIdSchema.optional().safeParse(pageId).success)
    throw new DesignPageTargetError("pageId must be a valid Design page ID.");
  const pages = canvas.pages ?? [{ id: "main", title: "Design", frames: [] }];
  if (pageId === undefined && pages.length !== 1)
    throw new DesignPageTargetError(
      "pageId required to create a frame in a directory with several pages.",
    );
  const page =
    pageId === undefined ? pages[0] : pages.find((page) => page.id === pageId);
  if (!page)
    throw new DesignPageTargetError(
      "Design page not found: " + pageId + ". Refresh before editing.",
    );
  return page;
}

export function designFramePage(
  canvas: CanvasDocument,
  file: string,
): CanvasPage {
  const folder = file.includes("/") ? file.split("/")[0] : undefined;
  const page = (
    canvas.pages ?? [{ id: "main", title: "Design", frames: [] }]
  ).find((page) => page.folder === folder);
  if (!page)
    throw new DesignPageTargetError(
      "Design frame page is missing: " + file + ". Refresh before editing.",
    );
  return page;
}

export function designPageFrameFiles(
  canvas: CanvasDocument,
  page: CanvasPage,
): string[] {
  return Object.keys(canvas.frames).filter((file) =>
    page.folder ? file.startsWith(page.folder + "/") : !file.includes("/"),
  );
}

/** A pathname alone cannot authorize restore after a page folder is reused. */
export function assertDesignFrameRestorePage(
  canvas: CanvasDocument,
  point: DesignFrameRestorePoint,
): CanvasPage {
  if (
    point.pageId === undefined &&
    canvas.pages?.some((page) => page.folder !== undefined)
  )
    throw new DesignPageTargetError(
      "Stored frame pageId is missing. Refresh Design history before restoring.",
    );
  const page = designPageForWrite(canvas, point.pageId);
  if (designFramePage(canvas, point.file).id !== page.id)
    throw new DesignPageTargetError(
      "The frame no longer belongs to its stored Design page. Refresh before restoring.",
    );
  return page;
}

/** Derive a read catalog without adding enumerable state to legacy documents
 * (pending transaction journals hash their exact internal JSON shape). */
export function designCanvasPageCatalog(
  canvas: CanvasDocument,
  legacyFiles: string[] = Object.keys(canvas.frames),
  paged = false,
): DesignPageSummary[] {
  if (!paged)
    return [
      {
        id: canvas.pages?.[0]?.id ?? "main",
        title: canvas.pages?.[0]?.title ?? "Design",
        folder: "",
        frameFiles: [
          ...new Set([...Object.keys(canvas.frames), ...legacyFiles]),
        ],
      },
    ];
  const fileById = new Map(
    Object.entries(canvas.frame_info).map(([file, info]) => [info.id, file]),
  );
  return (canvas.pages ?? []).map((page) => ({
    id: page.id,
    title: page.title,
    folder: page.folder!,
    frameIds: [...page.frames],
    frameFiles: page.frames.map((id) => {
      const file = fileById.get(id);
      if (!file) throw new Error("Design page references an unknown frame.");
      return file;
    }),
  }));
}
