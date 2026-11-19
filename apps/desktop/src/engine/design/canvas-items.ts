import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import path from "node:path";
import {
  DESIGN_CANVAS_ITEM_LIMITS,
  designCanvasItemInputProblem,
  isDesignCanvasItemId,
  readDesignCanvasPageItems,
  type DesignCanvasItem,
  type DesignCanvasItemIssue,
  type DesignCanvasItemSummary,
} from "@zeros/protocol/design-canvas-items";
import { designPageIdSchema, type DesignPageSummary } from "@zeros/protocol/design-pages";
import type { CanvasDocument, CanvasPage, DesignLintViolation } from "./document-model";
import { withDesignDocumentWrite } from "./document-write-lock";
import { initializeDesignDocumentUnlocked } from "./document-transactions";
import { readCanvas, writeCanvas } from "./document-storage";
import { designPageForWrite } from "./pages";
import { captureDesignCatalogPoint, publishDesignCatalogChange, type CaptureDesignCatalogChange } from "./page-history";

export class DesignCanvasItemError extends Error {}

const ITEM_FIELDS = new Set(["id", "kind", "x", "y", "width", "height", "text", "target", "title"]);

/** Every page's drawable items and what was skipped, keyed by page id. Ids
 * are checked against every frame id and every earlier item, in page order. */
export function readDesignCanvasItems(canvas: CanvasDocument): Map<string, { items: DesignCanvasItem[]; issues: DesignCanvasItemIssue[] }> {
  const pages = canvas.pages ?? [];
  const reserved = new Set<string>(pages.flatMap((page) => page.frames));
  const result = new Map<string, { items: DesignCanvasItem[]; issues: DesignCanvasItemIssue[] }>();
  for (const page of pages) result.set(page.id, readDesignCanvasPageItems(page.items, reserved));
  return result;
}

/** Each page summary with its drawable items; a page without any is left
 * exactly as it was, so a directory with no items reads unchanged. */
export function withDesignCanvasItems(canvas: CanvasDocument, pages: DesignPageSummary[]): DesignPageSummary[] {
  if (!(canvas.pages ?? []).some((page) => page.items !== undefined)) return pages;
  const items = readDesignCanvasItems(canvas);
  return pages.map((page) => {
    const read = items.get(page.id);
    const drawn = read?.items;
    const notShown = read?.issues.find(issue => issue.kind === "limit")?.count ?? 0;
    if (!drawn?.length && !notShown) return page;
    return { ...page, ...(drawn?.length ? { items: drawn } : {}), ...(notShown ? { itemsNotShown: notShown } : {}) };
  });
}

/** Link checks one snapshot read may make; further cards show as present
 * and Files reports a missing file when one opens. */
const MAX_LINK_CHECKS = 512;

/** Mark link cards whose file is not a regular file in the workspace. A
 * local stat only: nothing is read or fetched. */
export async function markMissingDesignCanvasLinks(workspacePath: string, pages: DesignPageSummary[]): Promise<DesignPageSummary[]> {
  if (!pages.some((page) => page.items?.some((item) => item.kind === "link"))) return pages;
  const present = new Map<string, Promise<boolean>>();
  const root = await realpath(workspacePath).catch(() => null);
  const check = (target: string): Promise<boolean> => {
    let known = present.get(target);
    if (known) return known;
    if (present.size >= MAX_LINK_CHECKS) return Promise.resolve(true);
    if (!root) return Promise.resolve(false);
    // The target is validated workspace-relative: no absolute, `.` or `..`.
    const file = path.join(workspacePath, ...target.split("/"));
    known = (async () => {
      let handle;
      try {
        const resolved = await realpath(file);
        const relative = path.relative(root, resolved);
        if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
        // The final component may have been replaced after realpath. Internal
        // symlinks are already resolved; do not follow a replacement here.
        handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        return (await handle.stat()).isFile();
      } catch {
        return false;
      } finally {
        await handle?.close().catch(() => undefined);
      }
    })();
    present.set(target, known);
    return known;
  };
  return Promise.all(pages.map(async (page) => {
    if (!page.items?.some((item) => item.kind === "link")) return page;
    const items = await Promise.all(page.items.map(async (item): Promise<DesignCanvasItemSummary> =>
      item.kind === "link" && !(await check(item.target)) ? { ...item, missing: true } : item));
    return { ...page, items };
  }));
}

/** canvas.json's own path, relative to the Design directory, for findings. */
function canvasFindingFile(layout: { directory: string; documentFile: string } | null | undefined): string {
  if (!layout) return "canvas.json";
  const relative = path.posix.relative(layout.directory, layout.documentFile);
  return relative && !relative.startsWith("..") ? relative : "canvas.json";
}

/** Items are chrome and never block Design work, so every finding is a
 * warning: skipped items, unsafe links, unknown kinds kept, missing files. */
export async function designCanvasItemViolations(
  workspacePath: string,
  canvas: CanvasDocument,
  layout: { directory: string; documentFile: string } | null | undefined,
  pageId?: string,
): Promise<DesignLintViolation[]> {
  if (!(canvas.pages ?? []).some((page) => page.items !== undefined)) return [];
  const file = canvasFindingFile(layout);
  const read = readDesignCanvasItems(canvas);
  const violations: DesignLintViolation[] = [];
  const links: Array<{ page: CanvasPage; item: DesignCanvasItem & { kind: "link" } }> = [];
  for (const page of canvas.pages ?? []) {
    if (pageId !== undefined && page.id !== pageId) continue;
    const { items, issues } = read.get(page.id)!;
    for (const issue of issues)
      violations.push({
        ruleId: issue.kind === "unsafe-link" ? "canvas-item-link-unsafe" : "canvas-item-invalid",
        severity: "warning",
        message: `Page ${page.title}, item ${issue.id ?? issue.index + 1}: ${issue.message}`,
        file, line: 1, column: 1,
        fix: issue.kind === "unsafe-link"
          ? "Point the link card at a workspace-relative file outside private folders, or remove it."
          : issue.kind === "unknown" ? "This kind is kept as written; remove it if it is a typo."
          : `Fix or remove the item in pages[].items of ${file}.`,
      });
    for (const item of items) if (item.kind === "link") links.push({ page, item });
  }
  const marked = await markMissingDesignCanvasLinks(workspacePath, [{
    id: "links", title: "", folder: "", frameFiles: [], items: links.map(({ item }) => item) }]);
  marked[0]!.items?.forEach((item, index) => {
    if (item.kind !== "link" || !item.missing) return;
    const { page } = links[index]!;
    violations.push({
      ruleId: "canvas-item-link-missing", severity: "warning",
      message: `Page ${page.title}, link card ${item.id}: ${item.target} is not a file in the workspace.`,
      file, line: 1, column: 1, fix: "Restore the file, point the card at its new path, or remove the card.",
    });
  });
  return violations;
}

function newItemId(canvas: CanvasDocument): string {
  const taken = new Set<string>((canvas.pages ?? []).flatMap((page) => [
    ...page.frames,
    ...(Array.isArray(page.items) ? page.items.flatMap((item: unknown) =>
      item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string" ? [(item as { id: string }).id] : []) : []),
  ]));
  for (;;) {
    const id = `item_${randomBytes(8).toString("hex")}`;
    if (!taken.has(id)) return id;
  }
}

function pageItemsForWrite(page: CanvasPage): unknown[] {
  if (page.items === undefined) return [];
  if (!Array.isArray(page.items))
    throw new DesignCanvasItemError("This page's items in canvas.json are not a list. Fix them in Files before placing items.");
  return page.items;
}

/** The stored position of the entry the reader draws for `id`, or -1. Entries
 * the reader skipped keep their id without taking it, so an earlier malformed
 * entry or a later duplicate with the same id is never the drawn one. */
function drawnItemIndex(stored: readonly unknown[], issues: readonly DesignCanvasItemIssue[], id: string): number {
  const skipped = new Set(issues.filter((issue) => issue.kind !== "limit").map((issue) => issue.index));
  return stored.findIndex((entry, position) => !skipped.has(position) &&
    !!entry && typeof entry === "object" && (entry as { id?: unknown }).id === id);
}

/** Create or replace one item on a page in one catalog write and one history
 * step. Fields of the stored entry that are not the item's own are kept. */
export async function putDesignCanvasItem(
  workspace: string,
  input: { pageId: unknown; item: unknown },
  capture?: CaptureDesignCatalogChange,
): Promise<DesignCanvasItem> {
  const pageId = designPageIdSchema.parse(input.pageId);
  const problem = designCanvasItemInputProblem(input.item);
  if (problem) throw new DesignCanvasItemError(problem);
  const requested = input.item as Record<string, unknown>;
  return withDesignDocumentWrite(workspace, async () => {
    await initializeDesignDocumentUnlocked(workspace);
    const canvas = await readCanvas(workspace);
    const before = capture ? captureDesignCatalogPoint(workspace, canvas) : undefined;
    const page = designPageForWrite(canvas, pageId);
    const stored = pageItemsForWrite(page);
    const id = requested.id === undefined ? newItemId(canvas) : requested.id as string;
    const drawn = readDesignCanvasItems(canvas).get(page.id)!;
    const index = requested.id === undefined ? -1 : drawnItemIndex(stored, drawn.issues, id);
    if (requested.id !== undefined) {
      const current = drawn.items.find((item) => item.id === id);
      if (index < 0 || !current)
        throw new DesignCanvasItemError("That item is not on this page any more. Refresh before editing it.");
      if (current.kind !== requested.kind) throw new DesignCanvasItemError("An item keeps its kind.");
    }
    // Authored extras survive; the item's own fields come from the request.
    const kept = index < 0 ? {} : Object.fromEntries(Object.entries(stored[index] as Record<string, unknown>)
      .filter(([key]) => !ITEM_FIELDS.has(key)));
    const entry = { ...kept, ...requested, id };
    const next = index < 0 ? [...stored, entry] : stored.map((value, position) => position === index ? entry : value);
    // The written page must still draw this item: caps and ids hold.
    const check = readDesignCanvasItems({ ...canvas, pages: (canvas.pages ?? []).map((candidate) =>
      candidate === page ? { ...candidate, items: next } : candidate) }).get(page.id)!;
    const written = check.items.find((item) => item.id === id);
    if (!written) {
      const issue = check.issues.find((candidate) => candidate.id === id || candidate.kind === "limit");
      throw new DesignCanvasItemError(issue?.kind === "limit"
        ? `A page holds at most ${DESIGN_CANVAS_ITEM_LIMITS.itemsPerPage} items and ${DESIGN_CANVAS_ITEM_LIMITS.textBytesPerPage / 1024} KiB of item text.`
        : issue?.message ?? "The item cannot be placed.");
    }
    page.items = next;
    await writeCanvas(workspace, canvas);
    publishDesignCatalogChange(workspace, before, canvas, [], capture);
    return written;
  });
}

/** Remove one drawn item in one catalog write and one history step. */
export async function deleteDesignCanvasItem(
  workspace: string,
  input: { pageId: unknown; itemId: unknown },
  capture?: CaptureDesignCatalogChange,
): Promise<{ id: string }> {
  const pageId = designPageIdSchema.parse(input.pageId);
  if (!isDesignCanvasItemId(input.itemId)) throw new DesignCanvasItemError("itemId must be an item id.");
  const itemId = input.itemId;
  return withDesignDocumentWrite(workspace, async () => {
    await initializeDesignDocumentUnlocked(workspace);
    const canvas = await readCanvas(workspace);
    const before = capture ? captureDesignCatalogPoint(workspace, canvas) : undefined;
    const page = designPageForWrite(canvas, pageId);
    const stored = pageItemsForWrite(page);
    const drawn = readDesignCanvasItems(canvas).get(page.id)!;
    if (!drawn.items.some((item) => item.id === itemId))
      throw new DesignCanvasItemError("That item is not on this page any more. Refresh before deleting it.");
    const index = drawnItemIndex(stored, drawn.issues, itemId);
    const next = stored.filter((_, position) => position !== index);
    if (next.length) page.items = next;
    else delete page.items;
    await writeCanvas(workspace, canvas);
    publishDesignCatalogChange(workspace, before, canvas, [], capture);
    return { id: itemId };
  });
}
