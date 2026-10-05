import { z } from "zod";
import { designFrameFileSchema, isDesignPageFolder } from "./design-path";

/** Directory-wide catalog. An empty folder denotes a virtual legacy root page. */
export interface DesignPageSummary {
  id: string;
  title: string;
  folder: string;
  frameFiles: string[];
}

export const designPageCatalogSchema = z.array(z.object({
  id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,127}$/),
  title: z.string().max(120),
  folder: z.string().refine((folder) => folder === "" || isDesignPageFolder(folder)),
  frameFiles: z.array(designFrameFileSchema).max(256),
})).min(1).max(64).superRefine((pages, ctx) => {
  const ids = new Set<string>(), folders = new Set<string>(), files = new Set<string>();
  for (const page of pages) {
    if (ids.has(page.id) || folders.has(page.folder) || (page.folder === "" && pages.length > 1))
      ctx.addIssue({ code: "custom", message: "Design pages must have distinct owners." });
    ids.add(page.id); folders.add(page.folder);
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
