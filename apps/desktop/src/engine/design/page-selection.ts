import { realpathSync } from "node:fs";
import path from "node:path";
import {
  designPageIdSchema,
  type DesignPageSummary,
} from "@zeros/protocol/design-pages";
import {
  readDesignDirectoryRegistry,
  readDirectoryDesignLayout,
} from "./metadata";
import { readCanvas } from "./document-storage";
import { withDesignDirectoryNameLease } from "./directory-registry";
import { designCanvasPageCatalog } from "./pages";

export interface DesignPageHint {
  directoryId: string;
  pageId: string;
}

const hints = new Map<string, DesignPageHint>();
const MAX_WORKSPACE_HINTS = 64;

function ownerKey(workspaceId: string, workspacePath: string): string {
  return JSON.stringify([workspaceId, realpathSync(workspacePath)]);
}

/** Read-class, best-effort context only. Never waits for a directory lease or
 * mutation lane, reads a canvas, or supplies a default for a source write. */
export function selectDesignPageHint(
  workspaceId: string,
  workspacePath: string,
  hint: DesignPageHint,
): void {
  designPageIdSchema.parse(hint.pageId);
  const directories = readDesignDirectoryRegistry(workspacePath)?.directories;
  if (!directories || !Object.hasOwn(directories, hint.directoryId))
    throw new Error(
      "Design directory is not registered in this workspace. Refresh before selecting a page.",
    );
  const key = ownerKey(workspaceId, workspacePath);
  hints.delete(key);
  hints.set(key, { ...hint });
  if (hints.size > MAX_WORKSPACE_HINTS)
    hints.delete(hints.keys().next().value!);
}

export function getDesignPageHint(
  workspaceId: string,
  workspacePath: string,
): DesignPageHint | null {
  // A missing checkout has no live hint.
  try {
    return (
      hints.get(ownerKey(workspaceId, path.resolve(workspacePath))) ?? null
    );
  } catch {
    return null;
  }
}

export interface DesignPageContext {
  pages: DesignPageSummary[];
  activePageId: string;
  hinted: boolean;
}

/** Read the current catalog before consuming an untrusted, potentially stale
 * hint. The fallback is prompt guidance only; writes still require pageId. */
export async function readDesignPageContext(target: {
  workspaceId: string;
  workspacePath: string;
  directory: string;
  directoryId: string;
}): Promise<DesignPageContext> {
  return withDesignDirectoryNameLease(
    target.workspacePath,
    target.directory,
    async () => {
      const canvas = await readCanvas(target.workspacePath);
      const paged =
        readDirectoryDesignLayout(target.workspacePath, target.directory)
          ?.canvasVersion === 2;
      const pages = designCanvasPageCatalog(canvas, undefined, paged);
      const hint = getDesignPageHint(target.workspaceId, target.workspacePath);
      const hintedPage =
        hint?.directoryId === target.directoryId
          ? pages.find((page) => page.id === hint.pageId)
          : undefined;
      return {
        pages,
        activePageId: (hintedPage ?? pages[0]!).id,
        hinted: !!hintedPage,
      };
    },
  );
}
