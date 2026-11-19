import { z } from "zod";
import {
  designFrameFileSchema,
  isDesignPageFolder,
  portableDesignName,
} from "./design-path";
import {
  DESIGN_CANVAS_ITEM_LIMITS,
  designCanvasItemsWithinLimits,
  isDesignCanvasItemSummary,
  type DesignCanvasItemSummary,
} from "./design-canvas-items";

/** Frames one page admits; per-page stacking `z` spans 0 through this value.
 * A directory has no frame cap of its own beyond its page count. */
export const DESIGN_MAX_FRAMES_PER_PAGE = 1_000;
export const DESIGN_MAX_PAGES = 64;

/** Directory-wide catalog. An empty folder denotes a virtual legacy root page. */
export interface DesignPageSummary {
  id: string;
  title: string;
  folder: string;
  frameFiles: string[];
  /** Registered membership, including sources that are missing or cannot render. */
  frameIds?: string[];
  /** Section titles, notes and link cards drawn on the page; absent when it
   * has none. Invalid entries in canvas.json are skipped, never sent. */
  items?: DesignCanvasItemSummary[];
  /** Valid items omitted by the page's item or text cap. Older engines omit it. */
  itemsNotShown?: number;
}

export const designPageIdSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_-]{0,127}$/, "Invalid Design page ID.");
export const designPageTitleSchema = z
  .string()
  .refine(
    (title) => !/[\u0000-\u001f\u007f-\u009f]/.test(title),
    "Page title must not contain control characters.",
  )
  .transform((title) => title.trim())
  .pipe(
    z
      .string()
      .min(1, "Page title cannot be empty.")
      .max(120, "Page title exceeds 120 characters."),
  );
export const designPageCreateInputSchema = z
  .object({ title: designPageTitleSchema.optional() })
  .strict();
export const designPageRenameInputSchema = z
  .object({ pageId: designPageIdSchema, title: designPageTitleSchema })
  .strict();
export const designPageDeleteInputSchema = z
  .object({
    pageId: designPageIdSchema,
    expectedFrameIds: z
      .array(designPageIdSchema)
      .max(DESIGN_MAX_FRAMES_PER_PAGE)
      .refine(
        (ids) => new Set(ids).size === ids.length,
        "Expected frame IDs must be distinct.",
      ),
  })
  .strict();

export const designPageCatalogSchema = z
  .array(
    z.object({
      id: designPageIdSchema,
      title: z.string().max(120),
      folder: z
        .string()
        .refine((folder) => folder === "" || isDesignPageFolder(folder)),
      frameFiles: z.array(designFrameFileSchema).max(DESIGN_MAX_FRAMES_PER_PAGE),
      frameIds: z.array(designPageIdSchema).max(DESIGN_MAX_FRAMES_PER_PAGE).optional(),
      items: z
        .array(z.custom<DesignCanvasItemSummary>(isDesignCanvasItemSummary))
        .max(DESIGN_CANVAS_ITEM_LIMITS.itemsPerPage)
        .refine(designCanvasItemsWithinLimits)
        .optional(),
      itemsNotShown: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    }),
  )
  .min(1)
  .max(DESIGN_MAX_PAGES)
  .superRefine((pages, ctx) => {
    const ids = new Set<string>(),
      folders = new Set<string>(),
      files = new Set<string>(),
      frameIds = new Set<string>(pages.flatMap((page) => page.frameIds ?? [])),
      itemIds = new Set<string>(),
      seenFrameIds = new Set<string>();
    for (const page of pages) {
      const folder = portableDesignName(page.folder);
      if (
        ids.has(page.id) ||
        folders.has(folder) ||
        (page.folder === "" && pages.length > 1)
      )
        ctx.addIssue({
          code: "custom",
          message: "Design pages must have distinct owners.",
        });
      ids.add(page.id);
      folders.add(folder);
      if (page.frameIds) {
        if (page.frameIds.length !== page.frameFiles.length)
          ctx.addIssue({
            code: "custom",
            message: "Design page frame IDs must match its files.",
          });
        for (const id of page.frameIds) {
          if (seenFrameIds.has(id))
            ctx.addIssue({
              code: "custom",
              message: "Design frame IDs must be distinct.",
            });
          seenFrameIds.add(id);
        }
      }
      for (const item of page.items ?? []) {
        if (frameIds.has(item.id) || itemIds.has(item.id))
          ctx.addIssue({
            code: "custom",
            message: "Design canvas item IDs must be distinct from frames and each other.",
          });
        itemIds.add(item.id);
      }
      for (const file of page.frameFiles) {
        const portable = portableDesignName(file);
        if (
          files.has(portable) ||
          (page.folder
            ? !file.startsWith(`${page.folder}/`)
            : file.includes("/"))
        )
          ctx.addIssue({
            code: "custom",
            message: "Design page frame membership is invalid.",
          });
        files.add(portable);
      }
    }
  });

/** Compatible wire normalization only; authored canvas documents are never
 * passed here or changed. Ready snapshots and frame objects keep their identity. */
export function normalizeDesignPagesSnapshot<
  T extends {
    pages?: DesignPageSummary[];
    frames: Array<{ file: string; pageId?: string }>;
  },
>(snapshot: T): T & { pages: DesignPageSummary[] } {
  const pages = snapshot.pages ?? [
    {
      id: "main",
      title: "Design",
      folder: "",
      frameFiles: snapshot.frames.map((frame) => frame.file),
    },
  ];
  const ownerByFile = new Map(
    pages.flatMap((page) =>
      page.frameFiles.map((file) => [file, page.id] as const),
    ),
  );
  let changed = false;
  const frames = snapshot.frames.map((frame) => {
    const pageId = ownerByFile.get(frame.file);
    if (frame.pageId === pageId) return frame;
    changed = true;
    return { ...frame, pageId };
  });
  return snapshot.pages && !changed
    ? (snapshot as T & { pages: DesignPageSummary[] })
    : { ...snapshot, pages, frames: changed ? frames : snapshot.frames };
}
