import { mkdir, rmdir } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { canvasReadSnapshot, type CanvasDocument } from "./document-model";
import { designDirectoryNameFor } from "./directory-registry";
import { readCanvas, writeCanvas } from "./document-storage";
import { withDesignDocumentWrite } from "./document-write-lock";
import { assertSafeDesignStoragePath, type DesignStorageChange } from "./metadata";
import { DesignPageTargetError } from "./pages";
import { assertDesignWriteAuthorized } from "./write-authority";

/** Engine-owned only. Exact tracked metadata plus the source changes of the
 * admitted write; no private viewport, screenshots or renderer snapshots. */
export interface DesignCatalogRestorePoint {
  directory: string;
  registration: { file: string; source: string | null };
  canvas: CanvasDocument;
}
export interface DesignCatalogChange {
  before: DesignCatalogRestorePoint;
  after: DesignCatalogRestorePoint;
  sources: DesignStorageChange[];
}
export type CaptureDesignCatalogChange = (change: DesignCatalogChange) => void;

function trackedCanvas(canvas: CanvasDocument): CanvasDocument {
  const { view: _view, ...tracked } = canvas;
  return structuredClone(tracked);
}

/** Capture from the same read whose CAS authorizes the write, not a second
 * read before/after it which could accidentally include an external edit. */
export function captureDesignCatalogPoint(workspace: string, canvas: CanvasDocument): DesignCatalogRestorePoint {
  const registration = canvas[canvasReadSnapshot]?.registration;
  if (!registration) throw new Error("Design catalog history requires an exact registration read.");
  return { directory: designDirectoryNameFor(workspace), registration: { ...registration }, canvas: trackedCanvas(canvas) };
}

export function publishDesignCatalogChange(
  workspace: string,
  before: DesignCatalogRestorePoint | undefined,
  after: CanvasDocument,
  sources: DesignStorageChange[],
  capture?: CaptureDesignCatalogChange,
): void {
  if (!before || !capture) return;
  const next = captureDesignCatalogPoint(workspace, after);
  if (isDeepStrictEqual(before.canvas, next.canvas) && !sources.some(change => change.before !== change.after)) return;
  capture({ before, after: next, sources: sources.map(change => ({ ...change })) });
}

/** Restore only if the exact catalog and every changed source still match.
 * The ordinary metadata journal supplies atomic source+catalog CAS/rollback.
 * A native change is a conflict, never permission to overwrite its files. */
export async function restoreDesignCatalogChange(
  workspace: string,
  change: DesignCatalogChange,
  direction: "undo" | "redo",
): Promise<void> {
  return withDesignDocumentWrite(workspace, async () => {
    const expected = direction === "undo" ? change.after : change.before;
    const replacement = direction === "undo" ? change.before : change.after;
    const current = await readCanvas(workspace);
    if (designDirectoryNameFor(workspace) !== expected.directory || replacement.directory !== expected.directory ||
        !isDeepStrictEqual(current[canvasReadSnapshot]?.registration, expected.registration) ||
        !isDeepStrictEqual(replacement.registration, expected.registration))
      throw new DesignPageTargetError("The Design directory changed after this catalog history entry.");
    for (const page of expected.canvas.pages ?? []) {
      const unchanged = replacement.canvas.pages?.find(candidate => candidate.id === page.id);
      if (!isDeepStrictEqual(page, unchanged) && !current.pages?.some(candidate => candidate.id === page.id && candidate.folder === page.folder))
        throw new DesignPageTargetError("Design page is missing or replaced: " + page.id + ". Refresh before restoring.");
    }
    if (!isDeepStrictEqual(trackedCanvas(current), expected.canvas))
      throw new Error("The Design catalog changed after this history entry. Refresh before restoring.");
    const next = structuredClone(replacement.canvas);
    // Keep the current compare-and-swap read and the user's private viewport.
    Object.defineProperty(next, canvasReadSnapshot, { value: current[canvasReadSnapshot] });
    if (current.view) next.view = current.view;
    const sources = change.sources.map(source => direction === "undo"
      ? { file: source.file, before: source.after, after: source.before } : { ...source });
    const created: string[] = [];
    try {
      for (const page of next.pages ?? []) {
        if (!page.folder || current.pages?.some(existing => existing.folder === page.folder)) continue;
        const target = path.join(workspace, expected.directory, page.folder);
        assertSafeDesignStoragePath(workspace, `${expected.directory}/${page.folder}/.zeros-validation`);
        assertDesignWriteAuthorized();
        try { await mkdir(target); created.push(target); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      }
      await writeCanvas(workspace, next, sources, { rollbackOnFailure: true });
    } catch (error) {
      // Only our empty directories can be removed. A native writer's content
      // makes rmdir fail safely and is never recursively deleted.
      for (const target of created) await rmdir(target).catch(() => {});
      throw error;
    }
    for (const page of current.pages ?? []) {
      if (!page.folder || next.pages?.some(existing => existing.folder === page.folder)) continue;
      // Empty folder cleanup is not part of the committed authored change.
      await rmdir(path.join(workspace, expected.directory, page.folder)).catch(() => {});
    }
  });
}
