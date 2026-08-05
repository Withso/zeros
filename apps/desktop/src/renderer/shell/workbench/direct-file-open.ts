// ──────────────────────────────────────────────────────────
// Direct File Open — one transition policy for chat links + quick open
// ──────────────────────────────────────────────────────────

import type { Action } from "@/renderer/state/workspace-store";

import {
  createFilesTab,
  findBlankFilesTab,
  type WorkbenchTab,
} from "./tab-model";

function baseName(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? path : path.slice(index + 1);
}

/** Resolve the workspace owner for a file link rendered inside a chat. The
 * chat's bound folder owns its Workbench slice; an engine session cwd is only a
 * pre-hydration fallback and must not redirect UI state into a subdirectory
 * scope the user is not viewing. */
export function chatFileOpenCwd(
  chatFolder: string | null | undefined,
  sessionCwd: string | null | undefined,
): string | undefined {
  return chatFolder || sessionCwd || undefined;
}

/** Build the complete atomic transition for a file opened outside its own
 * tree (agent-chat link or the + quick-open palette).
 *
 * Tree visibility belongs to the destination tab, so focusing a path or
 * filling an existing blank never writes it. Only a genuinely new File tab
 * receives the factory's collapsed default. `preferredBlankId` lets quick-open
 * consume the blank tab the user is already viewing; agent chat omits it and
 * therefore uses the fixed Files home first. */
export function buildDirectFileOpenAction(
  tabs: WorkbenchTab[],
  rawPath: string,
  options?: {
    /** Active matching File tab wins among intentional duplicate paths. */
    preferredExistingTabId?: string | null;
    /** Blank quick-open should consume before the fixed Files home. */
    preferredBlankId?: string | null;
    /** Exact workspace owner captured before an asynchronous resolution. */
    scope?: string;
  },
): Action {
  const path = rawPath.trim();
  if (!path) throw new Error("A direct file open requires a non-empty path");
  const scoped = options?.scope === undefined ? {} : { scope: options.scope };
  const preferredExisting = options?.preferredExistingTabId
    ? tabs.find(
        (tab) =>
          tab.id === options.preferredExistingTabId && tab.type === "files",
      )
    : undefined;

  const existing =
    preferredExisting?.filePath === path
      ? preferredExisting
      : tabs.find((tab) => tab.type === "files" && tab.filePath === path);
  if (existing) {
    // Activation alone preserves every tab-owned choice: expanded/collapsed
    // tree, viewer mode, diff intent, and editor state.
    return { type: "ACTIVATE_WORKBENCH_TAB", id: existing.id, ...scoped };
  }

  const preferredBlank = options?.preferredBlankId
    ? tabs.find(
        (tab) =>
          tab.id === options.preferredBlankId &&
          tab.type === "files" &&
          !tab.filePath,
      )
    : undefined;
  const blank = preferredBlank ?? findBlankFilesTab(tabs);
  if (blank) {
    return {
      type: "OPEN_WORKBENCH_TAB",
      id: blank.id,
      ...scoped,
      updates: {
        filePath: path,
        title: baseName(path),
        viewerMode: undefined,
      },
    };
  }

  return {
    type: "ADD_WORKBENCH_TAB",
    tab: createFilesTab(path),
    ...scoped,
  };
}
