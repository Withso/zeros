import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, rmdir } from "node:fs/promises";
import path from "node:path";
import { isDesignPageFolder } from "@zeros/protocol/design-path";
import { designPageCreateInputSchema, designPageDeleteInputSchema, designPageRenameInputSchema, type DesignPageSummary } from "@zeros/protocol/design-pages";
import { publishCloudWorkspacePath } from "../files/cloud-workspace-ownership";
import { withDesignDocumentWrite } from "./document-write-lock";
import { initializeDesignDocumentUnlocked } from "./document-transactions";
import { designDirectory, readBoundedDesignFrameSource, readCanvas, writeCanvas } from "./document-storage";
import { designDirectoryNameFor } from "./directory-registry";
import { assertSafeDesignStoragePath, type DesignStorageChange } from "./metadata";
import { designCanvasPageCatalog, designPageForWrite, designPageFrameFiles } from "./pages";
import { assertDesignWriteAuthorized } from "./write-authority";

const portable = (name: string) => name.normalize("NFC").toLowerCase();

function pageSlug(title: string, number: number): string {
  return title.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64).replace(/-+$/g, "") || `page-${number}`;
}

export async function createDesignPage(workspace: string, input: { title?: string } = {}): Promise<DesignPageSummary> {
  const parsed = designPageCreateInputSchema.parse(input);
  return withDesignDocumentWrite(workspace, async () => {
    await initializeDesignDocumentUnlocked(workspace);
    const canvas = await readCanvas(workspace);
    const pages = canvas.pages!;
    if (pages.length >= 64) throw new Error("Design directory exceeds the 64-page limit.");
    const occupied = new Set([...await readdir(designDirectory(workspace)), ...pages.map(page => page.folder!)].map(portable));
    let number = pages.length + 1;
    let title = parsed.title ?? `Page ${number}`;
    if (parsed.title === undefined) {
      while (pages.some(page => page.title === title) || occupied.has(`page-${number}`)) {
        number++;
        title = `Page ${number}`;
      }
    }
    const base = pageSlug(title, number);
    let folder = base;
    for (let suffix = 2; !isDesignPageFolder(folder) || occupied.has(portable(folder)); suffix++) {
      const ending = `-${suffix}`;
      folder = base.slice(0, 64 - ending.length).replace(/-+$/g, "") + ending;
    }
    const page = { id: `page_${randomUUID().replace(/-/g, "")}`, title, folder, frames: [] as string[] };
    const target = path.join(designDirectory(workspace), folder);
    assertSafeDesignStoragePath(workspace, `${designDirectoryNameFor(workspace)}/${folder}/.zeros-validation`);
    assertDesignWriteAuthorized();
    await mkdir(target);
    publishCloudWorkspacePath(target);
    pages.push(page);
    await writeCanvas(workspace, canvas);
    return designCanvasPageCatalog(canvas, undefined, true).find(candidate => candidate.id === page.id)!;
  });
}

export async function renameDesignPage(workspace: string, pageId: string, title: string): Promise<DesignPageSummary> {
  const input = designPageRenameInputSchema.parse({ pageId, title });
  return withDesignDocumentWrite(workspace, async () => {
    await initializeDesignDocumentUnlocked(workspace);
    const canvas = await readCanvas(workspace);
    const page = designPageForWrite(canvas, input.pageId);
    if (page.title !== input.title) {
      page.title = input.title;
      await writeCanvas(workspace, canvas);
    }
    return designCanvasPageCatalog(canvas, undefined, true).find(candidate => candidate.id === page.id)!;
  });
}

export async function deleteDesignPage(workspace: string, pageId: string, expectedFrameIds: readonly string[]): Promise<void> {
  const input = designPageDeleteInputSchema.parse({ pageId, expectedFrameIds });
  return withDesignDocumentWrite(workspace, async () => {
    await initializeDesignDocumentUnlocked(workspace);
    const canvas = await readCanvas(workspace);
    const page = designPageForWrite(canvas, input.pageId);
    if (canvas.pages!.length === 1) throw new Error("Cannot delete the last page.");
    const expected = new Set(input.expectedFrameIds);
    if (page.frames.length !== expected.size || page.frames.some(id => !expected.has(id)))
      throw new Error("The page's frame membership changed. Refresh and confirm its frames before deleting.");
    const sources: DesignStorageChange[] = [];
    for (const file of designPageFrameFiles(canvas, page)) {
      const relative = `${designDirectoryNameFor(workspace)}/${file}`;
      const target = assertSafeDesignStoragePath(workspace, relative);
      const present = await lstat(target).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      sources.push({ file: relative, before: present ? await readBoundedDesignFrameSource(workspace, file) : null, after: null });
      delete canvas.frames[file];
      delete canvas.frame_info[file];
    }
    canvas.pages = canvas.pages!.filter(candidate => candidate.id !== page.id);
    await writeCanvas(workspace, canvas, sources);
    assertDesignWriteAuthorized();
    // rmdir never follows a symlink or recursively removes unregistered source.
    await rmdir(path.join(designDirectory(workspace), page.folder!)).catch((error: NodeJS.ErrnoException) => {
      if (!["ENOENT", "ENOTEMPTY", "EEXIST", "ENOTDIR"].includes(error.code ?? "")) throw error;
    });
  });
}
