import { z } from "zod";
import { designFrameFileSchema, isDesignPageFolder } from "./design-path";

/** Directory-wide catalog. An empty folder denotes a virtual legacy root page. */
export interface DesignPageSummary {
  id: string;
  title: string;
  folder: string;
  frameFiles: string[];
  /** Registered membership, including sources that are missing or cannot render. */
  frameIds?: string[];
}

export const designPageIdSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,127}$/, "Invalid Design page ID.");
export const designPageTitleSchema = z.string()
  .refine(title => !/[\u0000-\u001f\u007f-\u009f]/.test(title), "Page title must not contain control characters.")
  .transform(title => title.trim())
  .pipe(z.string().min(1, "Page title cannot be empty.").max(120, "Page title exceeds 120 characters."));
export const designPageCreateInputSchema = z.object({ title: designPageTitleSchema.optional() }).strict();
export const designPageRenameInputSchema = z.object({ pageId: designPageIdSchema, title: designPageTitleSchema }).strict();
export const designPageDeleteInputSchema = z.object({
  pageId: designPageIdSchema,
  expectedFrameIds: z.array(designPageIdSchema).max(256)
    .refine(ids => new Set(ids).size === ids.length, "Expected frame IDs must be distinct."),
}).strict();

export const designPageCatalogSchema = z.array(z.object({
  id: designPageIdSchema,
  title: z.string().max(120),
  folder: z.string().refine((folder) => folder === "" || isDesignPageFolder(folder)),
  frameFiles: z.array(designFrameFileSchema).max(256),
  frameIds: z.array(designPageIdSchema).max(256).optional(),
})).min(1).max(64).superRefine((pages, ctx) => {
  const ids = new Set<string>(), folders = new Set<string>(), files = new Set<string>(), frameIds = new Set<string>();
  for (const page of pages) {
    const folder = page.folder.normalize("NFC").toLowerCase();
    if (ids.has(page.id) || folders.has(folder) || (page.folder === "" && pages.length > 1))
      ctx.addIssue({ code: "custom", message: "Design pages must have distinct owners." });
    ids.add(page.id); folders.add(folder);
    if (page.frameIds) {
      if (page.frameIds.length !== page.frameFiles.length)
        ctx.addIssue({ code: "custom", message: "Design page frame IDs must match its files." });
      for (const id of page.frameIds) {
        if (frameIds.has(id)) ctx.addIssue({ code: "custom", message: "Design frame IDs must be distinct." });
        frameIds.add(id);
      }
    }
    for (const file of page.frameFiles) {
      const portable = file.normalize("NFC").toLowerCase();
      if (files.has(portable) || (page.folder ? !file.startsWith(`${page.folder}/`) : file.includes("/")))
        ctx.addIssue({ code: "custom", message: "Design page frame membership is invalid." });
      files.add(portable);
    }
  }
  if (files.size > 256) ctx.addIssue({ code: "custom", message: "Design exceeds the directory-wide frame limit." });
});

/** Compatible wire normalization only; authored canvas documents are never
 * passed here or changed. Ready snapshots and frame objects keep their identity. */
export function normalizeDesignPagesSnapshot<T extends {
  pages?: DesignPageSummary[];
  frames: Array<{ file: string; pageId?: string }>;
}>(snapshot: T): T & { pages: DesignPageSummary[] } {
  const pages = snapshot.pages ?? [{ id: "main", title: "Design", folder: "", frameFiles: snapshot.frames.map((frame) => frame.file) }];
  const ownerByFile = new Map(pages.flatMap((page) => page.frameFiles.map((file) => [file, page.id] as const)));
  let changed = false;
  const frames = snapshot.frames.map((frame) => {
    const pageId = ownerByFile.get(frame.file);
    if (frame.pageId === pageId) return frame;
    changed = true;
    return { ...frame, pageId };
  });
  return snapshot.pages && !changed ? snapshot as T & { pages: DesignPageSummary[] }
    : { ...snapshot, pages, frames: changed ? frames : snapshot.frames };
}
